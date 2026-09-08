// Twilio TaskRouter is what actually feeds cal.com's routing attributes, and Slate
// has never read it (#2096).
//
// THE FINDING THIS EXISTS TO MEASURE. Slate takes each agent's debt tiers and
// backend service from Salesforce booleans (`LowDebt__c` and friends). cal.com takes
// the same facts from a Pipedream job that reads each Twilio worker's `teams` tags
// and writes them onto cal.com attributes. Two sources for one set of facts, and
// nothing reconciles them, so the parity comparison's agreement is maintained by
// whoever keeps Salesforce and Twilio in step rather than by anything structural.
//
// `Redistribute` is the sharp case: it exists ONLY as a Twilio tag. It is not a
// Salesforce field (the User object carries 14 custom fields and none is this one,
// checked 2026-09-08) and cal.com will not report per-user attribute values, so
// Twilio is the only place Slate can read it from.
//
// PURE, apart from `fetchTwilioWorkers`: the mapping and the diff are driven offline
// by `scripts/test-twilio-parity.ts`.

/**
 * Twilio team tag to the Slate attribute it means.
 *
 * Copied deliberately from the live Pipedream workflow rather than invented, so this
 * measures what cal.com ACTUALLY receives. If the workflow's mapping changes, this is
 * wrong and the diff will say everybody disagrees, which is the loud direction.
 */
export const TEAM_TO_DEBT_TIER: Readonly<Record<string, string>> = {
  "Low Debt: 20k - 30k": "low",
  "Med Debt: 30k - 50k": "medium",
  "High Debt: 50k+": "high",
  "Very High Debt: 70k+": "very_high",
  "Ultra High Debt: 100k+": "ultra_high",
};

export const TEAM_TO_BACKEND: Readonly<Record<string, string>> = {
  Achieve: "achieve",
  Beyond: "beyond",
};

/**
 * Twilio tags that are real, deliberate, and none of Slate's business.
 *
 * Measured live 2026-09-08: 107 of 146 addresses carried at least one tag outside the
 * routing vocabulary and every one was legitimate. Reporting them made the command
 * red on three quarters of the roster for a reason nobody should fix, which is how a
 * check stops being read by the second week (L36). The Pipedream job that feeds
 * cal.com ignores every one of these too, so they are not part of what cal.com
 * receives and cannot cause the two systems to disagree.
 *
 * Named here rather than achieved by widening the mapping, so the list has a reviewer
 * and a genuinely NEW tag is still reported (L129).
 */
export const IRRELEVANT_TAGS: readonly string[] = [
  // Cohort or skill tags. 95 and 35 workers respectively, and nothing in either
  // system routes on them.
  "Green",
  "Focus",
  // Role, which Slate takes from Salesforce.
  "Manager",
  // TaskRouter queue concerns, about how Twilio moves a call rather than who can
  // take a booking.
  "Cross Team Transfers",
  "1.9 Disposition - Not Manager",
];

/**
 * Manager assignment, as `Team <Manager Name>`.
 *
 * Matched by PREFIX rather than by naming the seven managers who hold one today,
 * because a list of names goes stale the first time somebody changes job, and the
 * condition being exempted is the reason rather than the names (L362). Slate takes
 * manager of record from Salesforce's `Agent_Manager__c` and never from Twilio, so
 * this is the same fact from a second source and out of scope for this comparison.
 */
export const MANAGER_TAG_PREFIX = "Team ";

/** Tags that are their own fact rather than a tier or a backend. */
export const NOT_LEGAL_ELIGIBLE_TAG = "Not Legal Eligible";
export const REDISTRIBUTE_TAG = "Redistribute";

/**
 * What Slate writes on `users.attributes` to record that IT took somebody out of
 * the bookable pool because of that tag (#2097).
 *
 * Beside the tag rather than in the planner, because the two are one fact seen from
 * either side, and a second spelling of the mark is how the flip off and the flip
 * back on stop being inverses of each other.
 */
export const REDISTRIBUTE_MARK = "Y";

/** What one Twilio worker says about somebody. */
export interface TwilioSide {
  email: string;
  debtTeams: string[];
  backendServices: string[];
  /** The worker carries the `Not Legal Eligible` tag. */
  notLegalEligible: boolean;
  /** The worker carries the `Redistribute` tag, so cal.com withholds them. */
  redistribute: boolean;
  /** Tags this mapping does not recognise, reported rather than dropped. */
  unmappedTags: string[];
}

/** Why a worker could not be read, kept apart because they are different faults. */
export type UnreadableWorker =
  /** The `attributes` string is not JSON. A Twilio data fault worth knowing about. */
  | "unreadable-attributes"
  /** Valid JSON carrying no email, so nothing can match it to a Slate row. */
  | "no-email";

export type WorkerRead = { ok: true; side: TwilioSide } | { ok: false; why: UnreadableWorker };

/**
 * Read one worker's `attributes` blob into the facts we compare.
 *
 * The two ways this fails are REPORTED SEPARATELY rather than folded into one
 * absent value (L11). A corrupt attributes string is a fault in Twilio's data and
 * somebody should look at it; a worker with valid JSON and no email is almost always
 * a queue or automation entity and is ordinary. One count covering both would name
 * whichever cause the message happened to describe, and the message would be wrong
 * about the other half.
 */
export function readWorker(attributesJson: string | null | undefined): WorkerRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(attributesJson || "{}");
  } catch {
    return { ok: false, why: "unreadable-attributes" };
  }
  const attrs = (parsed ?? {}) as { email?: unknown; teams?: unknown };
  const email = typeof attrs.email === "string" ? attrs.email.trim().toLowerCase() : "";
  if (!email) return { ok: false, why: "no-email" };

  const teams = Array.isArray(attrs.teams) ? attrs.teams.map((t) => String(t).trim()) : [];
  const debtTeams: string[] = [];
  const backendServices: string[] = [];
  const unmappedTags: string[] = [];
  let notLegalEligible = false;
  let redistribute = false;

  for (const tag of teams) {
    if (tag === "") continue;
    if (tag === NOT_LEGAL_ELIGIBLE_TAG) { notLegalEligible = true; continue; }
    if (tag === REDISTRIBUTE_TAG) { redistribute = true; continue; }
    const tier = TEAM_TO_DEBT_TIER[tag];
    if (tier !== undefined) { if (!debtTeams.includes(tier)) debtTeams.push(tier); continue; }
    const backend = TEAM_TO_BACKEND[tag];
    if (backend !== undefined) { if (!backendServices.includes(backend)) backendServices.push(backend); continue; }
    if (IRRELEVANT_TAGS.includes(tag)) continue;
    if (tag.startsWith(MANAGER_TAG_PREFIX)) continue;
    // A tag nobody mapped and nobody classified. Reported, never dropped: a new tier
    // added in Twilio would otherwise be invisible to the very check written to
    // notice drift (L217).
    if (!unmappedTags.includes(tag)) unmappedTags.push(tag);
  }

  return { ok: true, side: { email, debtTeams, backendServices, notLegalEligible, redistribute, unmappedTags } };
}

/** The side, or null. For call sites that genuinely do not care which fault it was. */
export function workerSideOrNull(read: WorkerRead): TwilioSide | null {
  return read.ok ? read.side : null;
}

/**
 * Merge the workers that share one email.
 *
 * The Pipedream job unions duplicates silently. This unions them too, so the
 * comparison measures what cal.com receives, and reports the duplication
 * separately, because two workers for one person is a real configuration fault
 * that a union hides.
 */
export function mergeWorkers(sides: TwilioSide[]): { merged: TwilioSide; duplicates: number } {
  const first = sides[0]!;
  const merged: TwilioSide = {
    email: first.email,
    debtTeams: [...new Set(sides.flatMap((s) => s.debtTeams))].sort(),
    backendServices: [...new Set(sides.flatMap((s) => s.backendServices))].sort(),
    notLegalEligible: sides.some((s) => s.notLegalEligible),
    redistribute: sides.some((s) => s.redistribute),
    unmappedTags: [...new Set(sides.flatMap((s) => s.unmappedTags))].sort(),
  };
  return { merged, duplicates: sides.length - 1 };
}

/** The domain Slate's own users are on. A worker anywhere else is not a colleague. */
export const OUR_DOMAIN = "@trypennie.com";

/** What Slate holds for the same person. */
export interface SlateSide {
  email: string;
  debtTeams: string[];
  backendServices: string[];
  /** Slate stores `legal_eligible: "N"` for somebody excluded from legal work. */
  legalEligibleN: boolean;
  bookable: boolean;
  deactivated: boolean;
}

export type TwilioVerdict =
  | "agree"
  /** Deactivated in Slate: nothing to reconcile, and asking would report a departure. */
  | "departed"
  /** A Twilio worker with no Slate row, so nothing can be compared. */
  | "absent-from-slate"
  /** A Twilio worker on somebody else's domain, so never a Slate user. */
  | "not-our-worker"
  /** In Slate, and no Twilio worker carries their address. */
  | "absent-from-twilio"
  /** Twilio carries a tag this mapping does not know. */
  | "unmapped-tag"
  /** Two or more Twilio workers share this address. */
  | "duplicate-worker"
  /** The debt tiers differ. */
  | "debt-teams-differ"
  /** The backend services differ. */
  | "backend-differs"
  /** Legal eligibility differs. */
  | "legal-differs"
  /** Twilio withholds them and Slate still offers them. */
  | "redistribute-still-bookable";

/** Worst last, so a run can be named by its worst row. */
export const TWILIO_VERDICT_RANK: Record<TwilioVerdict, number> = {
  agree: 0,
  departed: 0,
  // Level with agreement: sixteen Regal AI agents and vendor logins are never going
  // to be Slate users, and a rank of their own would fail every run forever.
  "not-our-worker": 0,
  "absent-from-twilio": 1,
  "duplicate-worker": 2,
  "unmapped-tag": 3,
  "absent-from-slate": 4,
  "legal-differs": 5,
  "backend-differs": 6,
  "debt-teams-differ": 7,
  // Worst: Slate is offering a lead to somebody the incumbent withholds, and it is
  // the one finding here that is already wrong today rather than latent.
  "redistribute-still-bookable": 8,
};

const same = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/**
 * Compare one person, worst finding first.
 *
 * Order is the design: the two attribute sets that decide which pool somebody is in
 * are asked before legal eligibility, and redistribute is asked before all of them
 * because it is the only one where a lead reaching Slate today would be misrouted.
 */
export function compareOne(
  twilio: TwilioSide | null,
  slate: SlateSide | null,
  duplicates = 0,
): { verdict: TwilioVerdict; detail: string } {
  if (slate === null) {
    if (twilio === null) return { verdict: "agree", detail: "" };
    // Judged by the REASON rather than by listing the sixteen that exist today, so a
    // thirteenth Regal AI agent needs no code change (L362). Slate's users are on our
    // own domain; a worker anywhere else is a vendor account or an automation.
    if (!twilio.email.endsWith(OUR_DOMAIN)) {
      return {
        verdict: "not-our-worker",
        detail: `a Twilio worker on ${twilio.email.split("@")[1] ?? "another domain"}, so never a Slate user`,
      };
    }
    return { verdict: "absent-from-slate", detail: "a Twilio worker with no Slate record, so nothing can be reconciled" };
  }
  if (slate.deactivated) return { verdict: "departed", detail: "" };
  if (twilio === null) {
    return {
      verdict: "absent-from-twilio",
      detail: "in Slate and no Twilio worker carries their address, so cal.com is fed nothing for them",
    };
  }
  if (twilio.redistribute && slate.bookable) {
    return {
      verdict: "redistribute-still-bookable",
      detail: "carries the Redistribute tag in Twilio and is still bookable in Slate, so Slate offers a lead somebody who should not take one",
    };
  }
  if (!same(twilio.debtTeams, slate.debtTeams)) {
    return {
      verdict: "debt-teams-differ",
      detail: `debt teams: Slate has [${slate.debtTeams.join(", ") || "none"}], Twilio has [${twilio.debtTeams.join(", ") || "none"}]`,
    };
  }
  if (!same(twilio.backendServices, slate.backendServices)) {
    return {
      verdict: "backend-differs",
      detail: `backend service: Slate has [${slate.backendServices.join(", ") || "none"}], Twilio has [${twilio.backendServices.join(", ") || "none"}]`,
    };
  }
  if (twilio.notLegalEligible !== slate.legalEligibleN) {
    return {
      verdict: "legal-differs",
      detail: `legal eligibility: Slate says ${slate.legalEligibleN ? "excluded" : "eligible"}, Twilio says ${twilio.notLegalEligible ? "excluded" : "eligible"}`,
    };
  }
  // These two rank BELOW the attribute differences on purpose: each is a fault in the
  // Twilio configuration rather than a disagreement about a person, and they must not
  // bury a real difference. They are asked last so a row with both is named by the
  // difference, which is the actionable half.
  if (duplicates > 0) {
    return {
      verdict: "duplicate-worker",
      detail: `${duplicates + 1} Twilio workers share this address, and their tags were unioned to compare`,
    };
  }
  if (twilio.unmappedTags.length > 0) {
    return {
      verdict: "unmapped-tag",
      detail: `Twilio tags this comparison does not know: ${twilio.unmappedTags.join(", ")}`,
    };
  }
  return { verdict: "agree", detail: "" };
}
