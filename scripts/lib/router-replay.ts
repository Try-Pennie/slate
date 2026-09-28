/**
 * Replaying a real cal.com lead through Slate's tier ladder (#2240).
 *
 * WHY IT EXISTS. cal.com has taken every real lead for months and recorded, per
 * routing form response, both the code the lead carried and the agent it chose.
 * Slate has routed nothing, so the only measurement of its routing available
 * before cutover is to ask it the same question about the same leads and compare.
 *
 * WHAT IT IS NOT. It is not a correctness check. cal.com is the incumbent, not the
 * source of truth, and a lead both systems would send to the same person can be
 * wrong in both. It measures whether the two systems would make the same choice.
 *
 * THE HALF THAT AGREES BY CONSTRUCTION. Since #2152 Slate's debt tiers and backend
 * service come from the same Twilio tags the Pipedream job feeds cal.com, so the
 * ATTRIBUTES both systems route on are one source. What this actually exercises is
 * everything downstream of that: the code resolution, the tier ladder and its
 * Beyond overflow, and the pool predicate. Any report has to say so, or a reader
 * takes a high agreement rate as evidence about a thing that was never in doubt.
 *
 * THE BASELINE IS NOT OPTIONAL. With the legal digit retired (#2218) the big pools
 * hold most of the roster, so picking an agent at random agrees most of the time.
 * An agreement rate reported without the requested pool's share of the roster
 * beside it is a number nobody can read, and `summarise` therefore carries the
 * share on every per code row.
 *
 * Pure: no network, no clock, no database. `scripts/test-router-replay.ts` drives
 * every class offline.
 */
import type { Attributes, Criteria } from "@/lib/db/types";
import { agentIdsFromPool } from "@/lib/availability/pool";
import { rungExcludesLow, tierLadder } from "@/lib/routing/tiers";
import { carriesLow } from "@/lib/availability/low-exclusion";
import { resolveRequestedCode } from "@/lib/routing/catchall";

/** A Slate user as the replay needs them. Every user, not only the bookable ones:
 *  "the host has left" and "Slate has never heard of them" are different findings. */
export interface ReplayUser {
  id: string;
  email: string;
  bookable: boolean;
  deactivated: boolean;
  isTest: boolean;
  attributes: Attributes;
}

/** A bucket with the members named on IT, never a union across buckets. */
export interface ReplayBucket {
  code: string;
  criteria: Criteria;
  memberIds: string[];
}

export interface ReplayWorld {
  users: ReplayUser[];
  buckets: ReplayBucket[];
}

/** One routed cal.com lead. */
export interface ReplayLead {
  formId: string;
  formName: string;
  responseId: number;
  createdAt: string;
  /** Exactly what the form held, unnormalised: a number, a string, or null when
   *  the form carries no xbc field at all. `resolveRequestedCode` decides what it
   *  means, so this module never holds a second copy of the code's shape. */
  rawCode: unknown;
  bookingUid: string;
  /** The hosts cal.com chose, lowercased. `null` is a booking that could not be
   *  read at all, which is a gap in coverage rather than a disagreement. */
  hostEmails: string[] | null;
  /**
   * Whether this run ASKED cal.com about the booking.
   *
   * A run is capped (`REPLAY_MAX_FETCH`), and the 30 day window holds about 25,000
   * routed leads against a cal.com budget of 120 requests a minute, so most leads
   * in a window are simply not asked about. An unsampled lead moves NO rate here:
   * folding it in makes the resolution rate a measurement of the cap rather than
   * of cal.com, and on the first live run that read as "only 10.5 percent of leads
   * had a readable host" when the truth was that 150 had been asked about and 139
   * of them agreed (L209: a threshold whose fixture moves the wrong variable).
   */
  sampled: boolean;
}

export type ReplayClass =
  /** The host is in the pool of the code the lead actually carried. */
  | "agree"
  /** The host is on a LOWER rung of that code's ladder. Weaker agreement, kept
   *  apart because Slate reaches a lower rung only when the rungs above it have
   *  nobody free, which nothing can establish after the fact. */
  | "agree-via-ladder"
  | "host-not-in-slate"
  | "host-departed"
  | "host-not-bookable"
  /** Bookable, present, and no rung's criteria select them. */
  | "host-attributes-exclude"
  /** No rung of the ladder holds anybody at all: a finding about Slate's staffing
   *  rather than a disagreement about this host. */
  | "bucket-has-nobody"
  /** cal.com named no host, or would not answer for the booking. */
  | "host-unreadable"
  | "catchall-absent"
  | "catchall-unreadable";

export interface ReplayVerdict {
  verdict: ReplayClass;
  requestedCode: string;
  /** The rung that holds the host, when one does. */
  effectiveCode: string | null;
  /** How far down the ladder that rung is, 0 for the requested code. */
  rungsDropped: number | null;
}

export interface PreparedWorld {
  byEmail: Map<string, ReplayUser>;
  /** Every bucket's own pool, resolved once for the run. */
  poolByCode: Map<string, Set<string>>;
  bookableCount: number;
}

/**
 * Resolve every bucket's pool once, through the booker's OWN predicate over that
 * bucket's own manual members.
 *
 * Never `matchableAgentIds`, which unions across every bucket: that answers "could
 * any bucket reach this agent", and using it here would report a Low member taking
 * a High lead as plain agreement, which is the measurement this exists to make.
 */
export function prepareWorld(world: ReplayWorld): PreparedWorld {
  const live = world.users.filter((u) => !u.isTest);
  const bookable = live.filter((u) => u.bookable && !u.deactivated);
  const orgAgents = bookable.map((u) => ({ id: u.id, attributes: u.attributes }));
  const poolByCode = new Map<string, Set<string>>();
  for (const b of world.buckets) {
    poolByCode.set(b.code, new Set(agentIdsFromPool(orgAgents, new Set(b.memberIds), b.criteria)));
  }
  return {
    byEmail: new Map(live.map((u) => [u.email.trim().toLowerCase(), u])),
    poolByCode,
    bookableCount: bookable.length,
  };
}

/**
 * The requested pool's share of the bookable roster: the chance a random agent
 * agrees. `null` when Slate holds no bucket for the code, which is not a share of
 * zero and must not be rendered as one.
 */
export function poolShare(code: string, world: PreparedWorld): number | null {
  const pool = world.poolByCode.get(code);
  if (!pool) return null;
  if (world.bookableCount === 0) return null;
  return pool.size / world.bookableCount;
}

/**
 * The xbc a routing form response carried, as text, or `null` when the form has no
 * such field.
 *
 * `null` and `""` are deliberately different: a form with no xbc field never asked,
 * and a blank one asked and got nothing. Both end at the catch-all, and both are
 * reported as `catchall-absent`, but the extraction keeps them apart so the count
 * of forms that do not carry a code at all is knowable.
 *
 * cal.com stores the value as a NUMBER when it looks like one, measured live on
 * 2026-09-11: `{"label":"xbc","value":22}`. So the digits are recovered with
 * `String`, and a two digit value stays two digits and is refused downstream,
 * exactly as it is by the live booker.
 */
export function extractCode(response: unknown): string | null {
  if (response === null || typeof response !== "object") return null;
  for (const field of Object.values(response as Record<string, unknown>)) {
    if (field === null || typeof field !== "object") continue;
    const { label, value } = field as { label?: unknown; value?: unknown };
    if (typeof label !== "string" || label.trim().toLowerCase() !== "xbc") continue;
    if (typeof value === "number") return String(value);
    if (typeof value === "string") return value;
    return "";
  }
  return null;
}

function codeText(raw: unknown): string {
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "string") return raw;
  return "";
}

/**
 * Which class one lead falls into. Exactly one, and the order is the argument.
 *
 * The CODE is decided first, before the host is looked at. Slate's answer for a
 * lead carrying nothing usable is "the Low pool" whoever cal.com booked it with,
 * and the Low pool is the biggest one, so counting those as agreement is precisely
 * what a broken code lookup would exploit: it would raise the headline rate while
 * making the run mean less.
 *
 * Then the host's STANDING in Slate, before their attributes, because "has left"
 * and "is held back" are facts about the roster that no pool membership can
 * overturn, and a departed agent whose attributes still match would otherwise be
 * counted as agreement.
 *
 * A booking with several hosts agrees if ANY of them is in a rung's pool, on the
 * nearest such rung. Agreement is the question "could Slate have chosen this
 * person", and it is answered yes if it could have chosen any of them.
 */
export function classifyLead(lead: ReplayLead, world: PreparedWorld): ReplayVerdict {
  const resolution = resolveRequestedCode(codeText(lead.rawCode));
  if (resolution.kind === "catchall") {
    return {
      verdict: resolution.reason === "absent" ? "catchall-absent" : "catchall-unreadable",
      requestedCode: resolution.code,
      effectiveCode: null,
      rungsDropped: null,
    };
  }
  const code = resolution.code;
  const bare = (v: ReplayClass): ReplayVerdict => ({
    verdict: v,
    requestedCode: code,
    effectiveCode: null,
    rungsDropped: null,
  });

  const emails = (lead.hostEmails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e !== "");
  if (emails.length === 0) return bare("host-unreadable");

  const users = emails.map((e) => world.byEmail.get(e) ?? null);
  if (users.every((u) => u === null)) return bare("host-not-in-slate");

  const known = users.filter((u): u is ReplayUser => u !== null);
  const routable = known.filter((u) => u.bookable && !u.deactivated);
  if (routable.length === 0) {
    // Reported by the reason that is true of somebody rather than by whichever
    // host came first: "departed" and "held back" send two different people to do
    // two different things, and departed is the one that cannot be undone.
    return bare(known.some((u) => u.deactivated) ? "host-departed" : "host-not-bookable");
  }

  const ladder = tierLadder(code);
  let anyRungStaffed = false;
  for (let rung = 0; rung < ladder.length; rung++) {
    const pool = world.poolByCode.get(ladder[rung]!);
    if (!pool) continue;
    if (pool.size > 0) anyRungStaffed = true;
    // #2842: below a top tier lead's own tier Slate offers only advisors without
    // Low, so a host who carries Low there is not somebody Slate would have chosen.
    const excludeLow = rungExcludesLow(code, ladder[rung]!);
    const hit = routable.find((u) => pool.has(u.id) && !(excludeLow && carriesLow(u.attributes)));
    if (hit) {
      return {
        verdict: rung === 0 ? "agree" : "agree-via-ladder",
        requestedCode: code,
        effectiveCode: ladder[rung]!,
        rungsDropped: rung,
      };
    }
  }
  return bare(anyRungStaffed ? "host-attributes-exclude" : "bucket-has-nobody");
}

const CLASSES: readonly ReplayClass[] = [
  "agree",
  "agree-via-ladder",
  "host-not-in-slate",
  "host-departed",
  "host-not-bookable",
  "host-attributes-exclude",
  "bucket-has-nobody",
  "host-unreadable",
  "catchall-absent",
  "catchall-unreadable",
] as const;

/**
 * The classes where Slate's LADDER actually got to decide: a code was read, and
 * cal.com's host is somebody Slate would route to. The agreement rate is over
 * these, and only these.
 *
 * The roster classes below are deliberately NOT in it, and the first live run is
 * why. On 2026-09-11, 294 of 328 judged leads agreed with a chance baseline of
 * 60.9 percent and not one lead disagreed about the ladder: every single miss was
 * `host-not-bookable`, cal.com routing to somebody Slate holds back. Counting
 * those as ladder disagreement put the headline at 89.6 percent and would have
 * failed the run for a finding this command does not own.
 */
const JUDGED: ReadonlySet<ReplayClass> = new Set<ReplayClass>([
  "agree",
  "agree-via-ladder",
  "host-attributes-exclude",
  "bucket-has-nobody",
]);

/**
 * cal.com chose somebody Slate's ROSTER rules out, before its ladder is reached.
 *
 * Reported loudly and counted, and it cannot fail a run, which is an exemption
 * with a reason rather than a verdict quietly left out of a table (L129).
 * `pnpm verify:calcom-parity` owns this question and pages on it under its own
 * exits (23 to 26); a second command failing daily on the same finding is how both
 * of them stop being read by the second week (L36). What it MUST not do is hide
 * inside the agreement rate, where a roster divergence reads as Slate routing
 * differently.
 */
const ROSTER: ReadonlySet<ReplayClass> = new Set<ReplayClass>([
  "host-not-in-slate",
  "host-departed",
  "host-not-bookable",
]);

export interface ReplayGroup {
  leads: number;
  byClass: Record<ReplayClass, number>;
}

export interface ReplayCodeRow extends ReplayGroup {
  code: string;
  /** The requested pool's share of the bookable roster: the chance baseline. */
  baseline: number | null;
}

export interface ReplayFormRow extends ReplayGroup {
  formId: string;
  formName: string;
}

export interface ReplaySummary {
  /** Leads in the window, sampled or not. Volume, never a denominator. */
  leadsInWindow: number;
  /** Leads this run asked cal.com about. Every rate below is over these. */
  leads: number;
  notSampled: number;
  judged: number;
  byClass: Record<ReplayClass, number>;
  byCode: ReplayCodeRow[];
  byForm: ReplayFormRow[];
  /** Share of ALL leads whose host could be read. */
  resolution: number;
  /** Share of ALL leads that fell to the catch-all. */
  catchallShare: number;
  /**
   * Leads whose host Slate's roster rules out before the ladder is reached. Not a
   * ladder disagreement, and never counted as one.
   */
  roster: number;
  /** Those as a share of the leads whose host could be read at all. */
  rosterShare: number;
  /** Share of JUDGED leads the two systems agree on, ladder agreement included. */
  agreement: number;
  /** The same over the requested code alone, which is the harder question. */
  strictAgreement: number;
  /** The requested pool's share of the roster, averaged over judged leads: the
   *  agreement a coin flip would reach on this traffic. */
  baseline: number | null;
}

function emptyCounts(): Record<ReplayClass, number> {
  return Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<ReplayClass, number>;
}

export function summarise(leads: ReplayLead[], world: PreparedWorld): ReplaySummary {
  const byClass = emptyCounts();
  const byCode = new Map<string, ReplayCodeRow>();
  const byForm = new Map<string, ReplayFormRow>();
  let judged = 0;
  let agree = 0;
  let strict = 0;
  let resolved = 0;
  let catchall = 0;
  let roster = 0;
  let baselineSum = 0;
  let baselineN = 0;

  let notSampled = 0;
  for (const lead of leads) {
    // Counted and then skipped entirely. It is not a class, because it is not a
    // fact about the lead: it is a fact about how far this run got.
    if (!lead.sampled) {
      notSampled++;
      continue;
    }
    const v = classifyLead(lead, world);
    byClass[v.verdict]++;
    const code =
      byCode.get(v.requestedCode) ??
      ({
        code: v.requestedCode,
        leads: 0,
        byClass: emptyCounts(),
        baseline: poolShare(v.requestedCode, world),
      } satisfies ReplayCodeRow);
    code.leads++;
    code.byClass[v.verdict]++;
    byCode.set(v.requestedCode, code);

    const form =
      byForm.get(lead.formId) ??
      ({ formId: lead.formId, formName: lead.formName, leads: 0, byClass: emptyCounts() } satisfies ReplayFormRow);
    form.leads++;
    form.byClass[v.verdict]++;
    byForm.set(lead.formId, form);

    if (v.verdict !== "host-unreadable") resolved++;
    if (v.verdict === "catchall-absent" || v.verdict === "catchall-unreadable") catchall++;
    if (ROSTER.has(v.verdict)) roster++;
    if (JUDGED.has(v.verdict)) {
      judged++;
      if (v.verdict === "agree" || v.verdict === "agree-via-ladder") agree++;
      if (v.verdict === "agree") strict++;
      const share = poolShare(v.requestedCode, world);
      if (share !== null) {
        baselineSum += share;
        baselineN++;
      }
    }
  }

  const sampled = leads.length - notSampled;
  return {
    leadsInWindow: leads.length,
    leads: sampled,
    notSampled,
    judged,
    byClass,
    byCode: [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code)),
    byForm: [...byForm.values()].sort((a, b) => a.formName.localeCompare(b.formName)),
    roster,
    rosterShare: resolved === 0 ? 0 : roster / resolved,
    resolution: sampled === 0 ? 0 : resolved / sampled,
    catchallShare: sampled === 0 ? 0 : catchall / sampled,
    agreement: judged === 0 ? 0 : agree / judged,
    strictAgreement: judged === 0 ? 0 : strict / judged,
    baseline: baselineN === 0 ? null : baselineSum / baselineN,
  };
}

/**
 * The share of leads whose host must be readable before the agreement rate means
 * anything. Below it the run says so instead of reporting a rate computed from
 * whatever happened to come back.
 */
export const MIN_RESOLUTION = 0.9;

/**
 * The share of leads that may fall to the catch-all before the run refuses.
 *
 * It is a ceiling rather than a curiosity because a broken code lookup RAISES the
 * headline: catch-all leads are excluded from the agreement denominator, so a bug
 * that pushed every lead into it would leave a tiny, flattering sample behind.
 * Measured 2026-09-04 across 6,000 responses, the real rate was about 2 percent.
 */
export const MAX_CATCHALL = 0.1;

/** Agreement below this is the finding the command exists to report. */
export const MIN_AGREEMENT = 0.9;

/** What the JUDGEMENT can conclude, once a run has its two sides. */
export type ReplayOutcome =
  | "agree"
  | "nothing-judged"
  | "resolution-too-low"
  | "catchall-too-high"
  | "disagreement";

/**
 * Every way this command can end, including the ones only the wiring can reach,
 * each on its own code.
 *
 * The wiring outcomes live HERE rather than in the command so one table holds
 * them all and the offline test can assert no two share a code: two outcomes on
 * one number is one message answering for another, which is how somebody spends
 * an afternoon on the wrong thing (L11).
 *
 * Finding nothing to compare is never a pass (L98), so there is no code meaning
 * "looked at nothing and was happy".
 */
export const REPLAY_EXIT = {
  /** No cal.com key or no Supabase credentials here. Nothing was attempted. */
  "not-configured": 1,
  /** No routed leads in the window, no bookable agents, or nothing judged. */
  "nothing-judged": 2,
  /** A Slate read failed, so the pools this compares against are not known. */
  "slate-unreadable": 3,
  /** cal.com would not answer for the forms or their responses. */
  "calcom-unreadable": 4,
  "resolution-too-low": 5,
  "catchall-too-high": 6,
  disagreement: 7,
  /**
   * Not ONE booking could be read, which is a broken read rather than a thin
   * sample: a wrong API version answers exactly like this for every uid, and
   * calling it "resolution too low" would send somebody to look at the data.
   */
  "hosts-unreadable": 8,
} as const satisfies Record<string, number>;

export interface OutcomeInput {
  leads: number;
  judged: number;
  resolution: number;
  catchallShare: number;
  agreement: number;
}

export function replayOutcome(s: OutcomeInput): { outcome: ReplayOutcome; exit: number } {
  // Judging nothing is never a pass (L98): an empty window and a window nothing
  // could read render the same in a report and identically in silence.
  if (s.leads === 0 || s.judged === 0) {
    return { outcome: "nothing-judged", exit: REPLAY_EXIT["nothing-judged"] };
  }
  if (s.resolution < MIN_RESOLUTION) {
    return { outcome: "resolution-too-low", exit: REPLAY_EXIT["resolution-too-low"] };
  }
  if (s.catchallShare > MAX_CATCHALL) {
    return { outcome: "catchall-too-high", exit: REPLAY_EXIT["catchall-too-high"] };
  }
  if (s.agreement < MIN_AGREEMENT) {
    return { outcome: "disagreement", exit: REPLAY_EXIT.disagreement };
  }
  return { outcome: "agree", exit: 0 };
}

/**
 * A cached booking reading, and whether this run may trust it.
 *
 * Kept here rather than in the command because both halves are DECISIONS, not
 * wiring: how long a reading stays good, and which readings can never be trusted
 * however fresh they are.
 */
export interface CachedBookingStamp {
  /** ISO start of the call, or null when the payload carried none. */
  start: string | null;
  /** When this entry was read from cal.com. */
  fetchedAt: string;
}

/** Two days. Long enough that a repeated run is cheap, short enough that a cache
 *  on somebody's laptop cannot quietly become the thing being measured. */
export const BOOKING_STALE_MS = 2 * 86_400_000;

/**
 * Whether a cached reading may be used as it stands.
 *
 * Three ways it may not, and they are separate reasons rather than one:
 *
 * - it was read more than `staleMs` ago;
 * - the call has NOT HAPPENED YET, because a future booking can still be moved or
 *   cancelled and the host can change with it;
 * - either of its own stamps cannot be read, which is not freshness at all but an
 *   entry nothing can vouch for. `Date.parse` answers NaN there, and every
 *   comparison with NaN is false, so an unreadable stamp would otherwise land on
 *   whichever branch the comparison's shape happens to give it (L50).
 */
export function freshBooking(
  entry: CachedBookingStamp | undefined,
  nowMs: number,
  staleMs: number = BOOKING_STALE_MS,
): boolean {
  if (!entry) return false;
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  if (nowMs - fetchedAt > staleMs) return false;
  const start = entry.start === null ? NaN : Date.parse(entry.start);
  if (!Number.isFinite(start)) return false;
  return start < nowMs;
}

/**
 * How a capped run divides its cal.com budget between the two windows.
 *
 * Newest first across the whole 30 days spends every read inside the PRIMARY
 * window, because that is where the newest leads are. The first live run reported
 * the secondary window with exactly the primary's numbers: a copy wearing a second
 * heading, and no answer at all to the question the second window exists for.
 *
 * So half the budget goes to leads older than the primary start. A half with
 * nothing left to ask about hands its remainder to the other rather than leaving
 * reads unspent, which matters most in the ordinary case where the older window
 * has long since been cached and the newer one has not.
 */
export function splitBudget(
  recentUnread: number,
  olderUnread: number,
  maxFetch: number,
): { recent: number; older: number } {
  if (maxFetch <= 0) return { recent: 0, older: 0 };
  const half = Math.floor(maxFetch / 2);
  const recent = Math.min(recentUnread, Math.max(half, maxFetch - olderUnread));
  return { recent, older: Math.min(olderUnread, maxFetch - recent) };
}
