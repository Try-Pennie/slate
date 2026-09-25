// What the roster sync writes for one person, from what Twilio says about them:
// the bookable flip Redistribute demands (#2097), and since #2152 the debt tiers
// and backend service themselves.
// PURE: driven offline by `scripts/test-twilio-roster-plan.ts`.
//
// EVERY FACT IS PLANNED TOGETHER, and that is the reason this is one function
// rather than four. They all live in the same `users.attributes` JSON column, so
// separate planners would each build a payload from the same base row and the last
// write would silently drop the rest (L443). Here every payload is derived once,
// from one read, and a row is never in two lists.
//
// TIERS AND BACKEND ARE MIRRORED WHOLESALE, exactly as Salesforce used to mirror
// them: the values Twilio carries replace whatever is stored, and a tag that has
// gone takes its value with it. A tier left behind because nothing removes it is an
// agent in a pool the source says they are not in, which is the failure this issue
// exists to end. Measured against production on 2026-09-10 before shipping: of 129
// in scope rows every one had a Twilio worker, two differed, and the only bookable
// account among them was the admin's own.
//
// A ROW TWILIO HOLDS NO WORKER FOR KEEPS ITS STORED TIERS UNTOUCHED. Silence about
// somebody is not the same as a source saying the value is gone (L214), and
// emptying every pool an agent belongs to on a partial read is not recoverable.
// `withoutWorker` counts them, because doing nothing is otherwise invisible.
//
// It used to also write those rows a legal eligibility value of N, which was the
// one place this planner acted on an absence rather than declining to. #2218
// retired the attribute, so the absence case now writes no fact about the person,
// which is what it should always have been for a fact nobody said anything about.
// The one thing it does write is a record of the absence itself (#2735, below).
//
// A `Redistribute` tag means the agent should not be taking booked calls (Dan,
// 2026-09-08). It exists only in Twilio, so this is the only place Slate can learn
// it, and until #2096 there was no way to see it at all.
//
// THE REVERSE FLIP IS A TRANSITION, NEVER A LEVEL (L60). Twilio's answer for
// somebody who should be bookable and somebody who has never been bookable is the
// same answer: no tag. Almost the whole roster is untagged, so a plan that flipped
// every untagged agent ON reads as a mirror of Twilio and is actually a mass
// activation: it would admit every new hire with no debt team and overturn every
// agent an admin turned off by hand.
//
// So Slate records the people IT turned off, in `attributes.redistribute`, and only
// a marked row is ever flipped back on. Two consequences worth stating, because
// both were decided rather than fallen into:
//
//  - An agent who is ALREADY not bookable and carries the tag is left alone and
//    NOT marked. Slate did not put them out of the pool, so it has no business
//    putting them back. This is also what keeps the activation gate quiet: a flip
//    ON is refused for an agent with no Google calendar and re-alerts every hour
//    (#2078), and two of the four withheld agents who are currently not bookable
//    have no calendar row at all.
//  - The gap that leaves, somebody cal.com would route to and Slate will not, is
//    not invisible: `pnpm verify:calcom-parity` reports it as exit 24, which is the
//    command whose job that comparison is.
//
// THE MARK IS NOT THE TAG (#2724). Because the mark records only what Slate DID,
// it misses everybody who was already out of the pool when the tag appeared
// (measured 2026-09-10: 13 of 22 tagged people). A reader asking "does Twilio say
// Redistribute about this person" (the Regal call detector) needs the tag itself, so
// it is mirrored as its own fact, `redistribute_tagged`, exactly as the tiers are:
// written for EVERY in scope worker whatever their bookable state, removed when the
// tag comes off, and left alone for a row Twilio holds no worker for. The mark keeps
// its one job, deciding who may be turned back on, and the two are never read for
// each other's question.
//
// A WORKER THAT DISAPPEARS IS RECORDED, NEVER ACTED ON (#2735). Keeping the stored
// tag for a row Twilio holds no worker for is right for the routing facts, and
// wrong for exactly one reader: the Regal call detector, whose exemption the tag
// grants, would go on exempting somebody whose Twilio worker no longer exists, for
// as long as it stays gone. Clearing the tag is not the answer, because the read
// may simply be partial (L214). So the planner writes the one thing the read did
// measure, `twilio_worker_missing_since`, the moment it first found no worker, and
// deletes it the run the worker is back. Every stored value stays as it was; the
// detector reads the stamp and stops trusting the tag. It is never written from an
// EMPTY Twilio side, which the caller refuses and which would otherwise stamp the
// whole roster at once.
import type { Attributes } from "@/lib/db/types";
import {
  REDISTRIBUTE_MARK,
  type TwilioSide,
} from "@/lib/twilio/roster";
import type { BackendValue, DebtTierValue } from "@/lib/routing/attribute-vocabulary";

/** What Slate holds for one person, as far as this decision is concerned. */
export interface TwilioRosterRow {
  id: string;
  email: string;
  bookable: boolean;
  /**
   * `bookable_pending_since` is set: an activation was already planned and refused.
   *
   * Read so this planner never plans it AGAIN. The retry belongs to the Salesforce
   * half, which retries every pending row it sees whatever the attributes now say,
   * and two owners for one retry is two flips an hour for one intent.
   */
  pending: boolean;
  /** Left the pool for good. Flipped neither way, and never reported as waiting. */
  deactivated: boolean;
  /** The SMOKE canary agents (#396), which no real Twilio tag may ever touch. */
  isTest: boolean;
  attributes: Attributes | null;
}

/**
 * One fact Twilio owns, as this run found it: the value to store, and whether it
 * MOVED.
 *
 * `changed` is carried rather than recomputed by the caller so a change can be
 * reported only once its write has landed. Without it a run would either claim a
 * change for every agent it touched or lose the ones where the value really moved
 * (#1134).
 */
export interface PlannedValue<T> {
  value: T;
  changed: boolean;
}

/** Everything Twilio says about one person, and what moved. */
export interface TwilioChanges {
  debtTeams: PlannedValue<DebtTierValue[]>;
  backendServices: PlannedValue<BackendValue[]>;
  /**
   * Whether the worker carries the `Redistribute` tag (#2724), and whether the row
   * READ as tagged before this run (#2735).
   *
   * `wasTagged` is carried because `changed` alone cannot tell a landing from a
   * clearing from a junk spelling being tidied, and the run reports the first two
   * by name while the third changes nothing a reader sees.
   */
  redistributeTagged: PlannedValue<boolean> & { wasTagged: boolean };
  /**
   * The moment the sync first found no Twilio worker for this row, or null while it
   * has one (#2735). Only ever what the read measured: it never changes a stored
   * routing fact, it records that the read could not vouch for them.
   */
  twilioWorkerMissingSince: PlannedValue<string | null>;
}

/** True when this row's payload changes anything at all. */
export function changesAnything(c: TwilioChanges): boolean {
  return (
    c.debtTeams.changed ||
    c.backendServices.changed ||
    c.redistributeTagged.changed ||
    c.twilioWorkerMissingSince.changed
  );
}

export type RedistributeAction = "turn-off" | "turn-back-on";

export interface PlannedRedistribute {
  userId: string;
  email: string;
  action: RedistributeAction;
  /**
   * The attributes to write with the flip, already merged over the row's own.
   *
   * Carried here rather than composed at the call site so the mark has ONE
   * spelling: a caller writing its own `{ redistribute: "Y" }` is a second
   * definition of the same fact, and the two drift silently (L370).
   *
   * It carries the routing facts, because they live in the
   * same JSON column and two writes built from one base would drop each other.
   */
  attributes: Attributes;
  /**
   * For a `turn-back-on` only: what to write when the flip does NOT settle (refused
   * by the activation gate, or deferred by the run's allowance). Every Twilio owned
   * fact applied and the mark KEPT, so the retry survives while a tag that has come
   * off stops reading as present (#2724). Null for a `turn-off`, whose payload is
   * written before the flip and so always lands.
   */
  heldAttributes: Attributes | null;
  /** What Twilio says about them, and which of it moved. */
  changes: TwilioChanges;
  /**
   * The moment Slate marked them, for a `turn-off` only, and null on the way back
   * in (#2115).
   *
   * It is the coverage sweep's idempotency key AND the sweep's window start, and it
   * is READ BACK from the row whenever one is already stored: a run that died
   * between the mark and the flip leaves a marked and still bookable agent, and
   * minting a fresh stamp next hour would be a fresh key, so the unique index would
   * never fire and the sweep would run twice.
   */
  markedAtIso: string | null;
}

/**
 * The Twilio owned attributes to write for somebody the run is NOT flipping.
 *
 * Kept apart from the flips because a row is never in both: a flip's payload
 * already carries every value, so applying both would be two writes over one
 * column from one base.
 */
export interface AttributeWrite {
  userId: string;
  email: string;
  /** The whole attributes object to write, merged over the row's own. */
  attributes: Attributes;
  changes: TwilioChanges;
}

export interface RedistributePlan {
  flips: PlannedRedistribute[];
  /** The attributes to write for rows this run is not flipping. */
  attributeWrites: AttributeWrite[];
  /**
   * Emails Slate marked and Twilio holds no worker for, so nothing can say whether
   * the tag was removed or the worker simply went away.
   *
   * Reported rather than acted on. A source that is PRESENT but silent about one
   * person is not the same as a source saying the tag is gone (L214), and treating
   * it as one would re-admit somebody on an absence. Doing nothing is correct here
   * and therefore invisible, which is why it is counted.
   */
  markedWithNoWorker: string[];
  /**
   * Every in scope Slate row Twilio holds no worker for.
   *
   * No fact about them is written: their tiers and tag are left exactly as stored,
   * because silence about somebody is not a source saying their values are gone,
   * and emptying every pool they belong to on a partial read is not recoverable.
   * The only write is the `twilio_worker_missing_since` stamp (#2735), which records
   * the absence rather than acting on it.
   *
   * That makes the count the only visible sign of a PARTIAL Twilio read. A read that
   * returned no workers at all is refused by the caller, but one that returned
   * half the roster would quietly exclude the other half, and this count is what
   * that looks like. Measured 2026-09-09 it is zero: all 125 live Slate users
   * have a Twilio worker.
   */
  withoutWorker: string[];
}

/** True when SLATE turned this person out of the pool because of the tag. */
export function isMarkedRedistribute(attributes: Attributes | null | undefined): boolean {
  return String(attributes?.redistribute ?? "") === REDISTRIBUTE_MARK;
}

/**
 * The key mirroring whether Twilio carries the `Redistribute` tag (#2724). One
 * spelling, read and written only through the two functions beside it (L370).
 */
export const REDISTRIBUTE_TAGGED_KEY = "redistribute_tagged";

/**
 * True when Twilio carried the `Redistribute` tag for this person at the last sync,
 * whatever their bookable state. NOT the same question as `isMarkedRedistribute`,
 * which is only the people Slate itself turned off.
 */
export function carriesRedistributeTag(attributes: Attributes | null | undefined): boolean {
  return String(attributes?.[REDISTRIBUTE_TAGGED_KEY] ?? "") === REDISTRIBUTE_MARK;
}

/**
 * The key recording that the last sync found no Twilio worker for this person
 * (#2735), holding the moment it FIRST found none. One spelling, read and written
 * only through the functions beside it (L370).
 */
export const TWILIO_WORKER_MISSING_KEY = "twilio_worker_missing_since";

/**
 * True when the last roster sync found no Twilio worker for this person, so the
 * Twilio facts stored for them (the `Redistribute` tag among them) are what Twilio
 * said LAST, not what it says now.
 *
 * Any value under the key reads as missing, a malformed one included: the only
 * reader is a detector deciding whether to trust an exemption, and an unreadable
 * stamp must fail toward reporting rather than toward silence.
 */
export function twilioWorkerMissing(attributes: Attributes | null | undefined): boolean {
  return attributes != null && TWILIO_WORKER_MISSING_KEY in attributes;
}

/** When the sync first found no worker, or null when there is no readable stamp. */
export function twilioWorkerMissingSinceMs(attributes: Attributes | null | undefined): number | null {
  const raw = attributes?.[TWILIO_WORKER_MISSING_KEY];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function withMark(attributes: Attributes | null, markedAtIso: string): Attributes {
  return { ...(attributes ?? {}), redistribute: REDISTRIBUTE_MARK, redistribute_at: markedAtIso };
}

function withoutMark(attributes: Attributes | null): Attributes {
  const next = { ...(attributes ?? {}) };
  delete next.redistribute;
  // The stamp goes WITH the mark. Left behind, a later pool exit would key its
  // coverage sweep onto the stamp of the previous one, and the unique index would
  // refuse the new sweep while the old job explained nothing about it.
  delete next.redistribute_at;
  return next;
}

/**
 * The stamp already stored for this mark, or null when there is nothing usable.
 *
 * A value that is not a readable instant cannot key anything, so it is replaced
 * rather than carried into the database as a corrupt key. `Date.parse` answers NaN
 * for an unreadable string and every comparison with NaN is false, so this asks
 * `Number.isFinite` rather than letting the unreadable value through (L50).
 */
function storedMarkStamp(attributes: Attributes | null | undefined): string | null {
  const raw = attributes?.redistribute_at;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return Number.isFinite(Date.parse(raw)) ? raw : null;
}


/**
 * Whether a stored list key already holds exactly what this run would write.
 *
 * Compared as the SERIALIZED value rather than as a set, for two reasons that a
 * set comparison gets wrong in opposite directions. Order is part of the value:
 * the vocabulary declares it (highest debt first) and two rows carrying the same
 * tiers in different orders are not the same row to anybody reading them (L228).
 * And a key holding something that is not a list at all (the boolean the retired
 * admin control used to write, #2120) must read as different from an empty write,
 * or the junk stays forever because "absent" and "unreadable" would compare equal.
 *
 * An ABSENT key and an EMPTY value are the one pair that compares equal, because
 * an agent with no tiers carries no `debt_team` key: that is what Salesforce wrote
 * before this and what every reader already expects.
 */
function listAlreadyStored(attributes: Attributes | null | undefined, key: string, next: readonly string[]): boolean {
  const attrs = (attributes ?? {}) as Record<string, unknown>;
  const stored = key in attrs ? JSON.stringify(attrs[key]) : null;
  return stored === (next.length > 0 ? JSON.stringify(next) : null);
}

/**
 * What Twilio says about this person, against what Slate holds.
 *
 * A row Twilio holds no worker for keeps its stored tiers, so nothing is planned
 * for it at all (the header says why).
 */
function planChanges(
  attributes: Attributes | null,
  worker: TwilioSide | null,
  stampMissing: boolean,
  nowIso: string,
): TwilioChanges {
  const debtTeams = worker ? worker.debtTeams : storedList<DebtTierValue>(attributes, "debt_team");
  const backendServices = worker ? worker.backendServices : storedList<BackendValue>(attributes, "backend_service");
  const storedTag = carriesRedistributeTag(attributes);
  const tagged = worker ? worker.redistribute : storedTag;
  // Compared against the RAW stored value rather than the reading of it, so a key
  // holding anything but the one spelling is rewritten rather than kept as junk.
  const rawTag = (attributes ?? {})[REDISTRIBUTE_TAGGED_KEY];
  const tagAlreadyStored = tagged ? rawTag === REDISTRIBUTE_MARK : rawTag === undefined;
  // The stamp is kept once written, so it says when the worker FIRST went missing,
  // and is rewritten only when what is stored is not a readable instant.
  const storedMissing =
    twilioWorkerMissingSinceMs(attributes) !== null ? String(attributes?.[TWILIO_WORKER_MISSING_KEY]) : null;
  const missingSince = !worker && stampMissing ? (storedMissing ?? nowIso) : null;
  const missingAlreadyStored =
    missingSince === null ? !twilioWorkerMissing(attributes) : storedMissing === missingSince;
  return {
    redistributeTagged: { value: tagged, changed: !tagAlreadyStored, wasTagged: storedTag },
    twilioWorkerMissingSince: { value: missingSince, changed: !missingAlreadyStored },
    debtTeams: { value: debtTeams, changed: !listAlreadyStored(attributes, "debt_team", debtTeams) },
    backendServices: {
      value: backendServices,
      changed: !listAlreadyStored(attributes, "backend_service", backendServices),
    },
  };
}

/** The list a row already holds, for the absence case where nothing replaces it. */
function storedList<T extends string>(attributes: Attributes | null | undefined, key: string): T[] {
  const v = (attributes ?? {})[key as keyof Attributes];
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * The row's attributes with every Twilio owned value applied.
 *
 * An empty list DELETES its key rather than storing `[]`, because an agent with no
 * tiers has always carried no `debt_team` key at all and every reader was written
 * against that.
 */
function withTwilioFacts(attributes: Attributes | null, changes: TwilioChanges): Attributes {
  const next: Attributes = { ...(attributes ?? {}) };
  if (changes.debtTeams.value.length > 0) next.debt_team = [...changes.debtTeams.value];
  else delete next.debt_team;
  if (changes.backendServices.value.length > 0) next.backend_service = [...changes.backendServices.value];
  else delete next.backend_service;
  if (changes.redistributeTagged.value) next[REDISTRIBUTE_TAGGED_KEY] = REDISTRIBUTE_MARK;
  else delete next[REDISTRIBUTE_TAGGED_KEY];
  if (changes.twilioWorkerMissingSince.value !== null) {
    next[TWILIO_WORKER_MISSING_KEY] = changes.twilioWorkerMissingSince.value;
  } else delete next[TWILIO_WORKER_MISSING_KEY];
  return next;
}

/**
 * Decide every flip, from the roster Slate holds and the workers Twilio answered
 * with.
 *
 * `nowIso` is injected rather than read from the clock, so the stamp a flip carries
 * is a value a test can assert on and two runs in one test cannot disagree.
 *
 * `twilioByEmail` is keyed on the lowercased address, as `readWorker` produces it.
 * An EMPTY map flips nobody in either direction: the caller refuses a read that
 * returned no workers before ever getting here, and this is the second half of that
 * refusal, because an empty map must never read as "nobody is tagged any more".
 *
 * An unseen row is planned nothing, and the caller's refusal is what stops a run
 * reaching here on a read that answered with nothing at all.
 */
export function planTwilioRoster(
  rows: TwilioRosterRow[],
  twilioByEmail: Map<string, TwilioSide>,
  nowIso: string,
): RedistributePlan {
  const flips: PlannedRedistribute[] = [];
  const attributeWrites: AttributeWrite[] = [];
  const markedWithNoWorker: string[] = [];
  const withoutWorker: string[] = [];
  // An EMPTY Twilio side stamps nobody as missing (#2735). The caller refuses a read
  // that returned no workers, but a read whose every worker was unreadable reaches
  // here as an empty map, and stamping the whole roster on it would page on every
  // Redistribute agent at once about a Twilio data fault that is reported elsewhere.
  const stampMissing = twilioByEmail.size > 0;

  for (const row of rows) {
    if (row.deactivated || row.isTest) continue;
    const email = row.email.trim().toLowerCase();
    const worker = twilioByEmail.get(email) ?? null;
    const marked = isMarkedRedistribute(row.attributes);
    if (!worker) withoutWorker.push(email);

    // Every Twilio owned value first, so whatever payload this row ends up with
    // carries all of them and nothing is written over the same column twice.
    const changes = planChanges(row.attributes, worker, stampMissing, nowIso);
    const base = changesAnything(changes) ? withTwilioFacts(row.attributes, changes) : (row.attributes ?? {});

    if (worker?.redistribute) {
      // Twilio withholds them. Only a flip is planned, and only from inside the
      // pool: an agent already out of it is left exactly as they are.
      if (row.bookable) {
        const markedAtIso = storedMarkStamp(row.attributes) ?? nowIso;
        flips.push({
          userId: row.id,
          email,
          action: "turn-off",
          attributes: withMark(base, markedAtIso),
          heldAttributes: null,
          changes,
          markedAtIso,
        });
        continue;
      }
    } else if (marked) {
      if (!worker) {
        markedWithNoWorker.push(email);
      } else {
        // Marked, and Twilio has a worker for them that no longer carries the tag.
        // Planned even when the row is already bookable, because the mark is then
        // stale and the flip is what clears it.
        flips.push({
          userId: row.id,
          email,
          action: "turn-back-on",
          attributes: withoutMark(base),
          heldAttributes: base,
          changes,
          markedAtIso: null,
        });
        continue;
      }
    }

    // No flip carries this row's payload, so it needs its own write.
    //
    // The activation is asked on the SAME pair this write moves between, the
    // attributes as stored and the attributes about to be stored, which is the only
    // place the transition is visible (#2152). Somebody Twilio withholds is never
    // activated: `worker.redistribute` above has already left them out of the pool,
    // and reaching here means they were out of it before this run began.
    if (changesAnything(changes)) {
      attributeWrites.push({ userId: row.id, email, attributes: base, changes });
    }
  }

  return { flips, attributeWrites, markedWithNoWorker, withoutWorker };
}
