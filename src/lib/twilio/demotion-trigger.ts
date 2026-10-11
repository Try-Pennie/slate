// #3582 Phase 3: the demotion trigger over a Twilio roster plan.
//
// After the roster plan is built, this decides what the demotion lifecycle does for each
// affected agent: stamp a new narrowing, sweep an aged one, or clear a resolved one. The pure
// verdicts live in `demotion-plan.ts` (planDemotionAction / applyDemotionAction); this is the
// orchestration that pairs each agent with their bookings and folds the result into one write.
//
// WHICH AGENTS ARE EVALUATED:
//  - a plan attribute write whose debt_team or backend_service CHANGED this sync (a possible
//    narrowing; a widening decides to `none` and writes nothing extra), and
//  - any roster row that already carries a demotion mark (a pending lifecycle to sweep or clear),
//    excluding rows being redistribute-FLIPPED (their full coverage sweep already moves every
//    call, so a partial demotion sweep on top would be redundant) and rows the plan already has
//    an attribute write for (handled by the first set).
//
// NO PER RUN CAP, deliberately, matching the redistribute sync beside it: the hourly agents cron
// is its OWN scheduled invocation (not one of the four every-minute lanes), subrequests are not a
// constraint at the 10,000 ceiling, and the sweeps are ENQUEUED (paced by the bulk-reassign drain
// lane) rather than moved here. A cap would hide a backlog rather than report one (sync.ts's own
// rationale). A mass re-tier of ~80 reads ~80 candidate sets and enqueues ~80 jobs, well within
// one invocation. (The #3613 brief asked for a cap assuming a shared budget; the budget is not
// shared, so the cap would only mask a backlog.)
import type { Attributes } from "@/lib/db/types";
import type { RerouteCandidate } from "@/lib/booking/reroute-eligibility";
import {
  applyDemotionAction,
  demotionTiersOf,
  mayNarrowEligibility,
  planDemotionAction,
  storedDemotionStamp,
  withDemotionMark,
} from "@/lib/booking/demotion-plan";
import { log } from "@/lib/log";
import type { RedistributePlan, TwilioChanges, TwilioRosterRow } from "@/lib/twilio/roster-plan";

/** A sweep or clear the demotion trigger needs, as a SEPARATE write after the core tier write,
 *  carrying the agent's current attributes with the swept marker added or the mark cleared. A
 *  new STAMP is not here: it rides in the core tier write (see `stampOverlays`), because it must
 *  land in the SAME write as the tiers that caused it. */
export interface DemotionWrite {
  userId: string;
  email: string;
  /** The attributes to store: the agent's current attributes with the swept marker added, or
   *  the mark cleared. Re-states the tiers so the write does not drop them. */
  attributes: Attributes;
  /** The stored stamp to key the enqueue on, for a sweep; null for a clear. */
  sweepMarkedAtIso: string | null;
  kind: "sweep-overdue" | "clear";
}

/** What the demotion trigger decided for the roster this sync. */
export interface DemotionResolution {
  /** userId -> the core tier write's attributes with a demotion mark folded in. The sync applies
   *  these in the base attribute-write loop, so the stamp lands in the SAME write as the narrowed
   *  tiers (crash-safe: never tiers without their mark). Holds both a confirmed stamp and a
   *  DEFENSIVE one written when the decision's read failed but the attributes may have narrowed. */
  stampOverlays: Map<string, Attributes>;
  /** The separate sweep/clear writes, applied after the base loop so a sweep enqueue or its
   *  marker write failing can never lose the core tier write. */
  sweepClearWrites: DemotionWrite[];
  /** Agents whose decision threw, counted and logged, so the auxiliary pass never aborts the
   *  core roster sync (L73). The core tier write is NEVER withheld on a failure: that would let a
   *  persistent read fault block an agent's routing facts. A possible narrowing is instead kept
   *  with a defensive stamp (see `stampOverlays`). */
  evalFailures: number;
}

/** One agent to run the demotion decision for. `changes` non-null marks a tier-changed row the
 *  base loop is already writing (so an eval failure for it may stamp defensively). */
interface DemotionEval {
  userId: string;
  email: string;
  before: Attributes | null;
  after: Attributes;
  changes: TwilioChanges | null;
}

/**
 * Which agents the demotion trigger evaluates this sync, and with what before/after. Pure, so
 * `scripts/test-demotion-trigger.ts` pins the selection without a database.
 */
export function demotionEvalList(roster: TwilioRosterRow[], plan: RedistributePlan): DemotionEval[] {
  const rosterById = new Map(roster.map((r) => [r.id, r]));
  const flipped = new Set(plan.flips.map((f) => f.userId));
  const writesByUser = new Map(plan.attributeWrites.map((w) => [w.userId, w]));
  const evals: DemotionEval[] = [];
  // Only the rows the FIRST loop actually evaluates (a tier/backend change), so the second loop
  // excludes exactly those rather than every row with any attribute write: a stamped row whose
  // write changed only the redistribute tag is not evaluated above, and must still be swept below.
  const tierEvaluated = new Set<string>();

  // A tier/backend change this sync: a possible narrowing. The decision reads the bookings and
  // stamps only a CONFIRMED one; a widening writes nothing extra. The deactivated / test / flipped
  // checks are asserted here too, not left to planTwilioRoster's own filtering: a rule correct
  // only as a side effect of another has no owner (L281), and a demotion must never stamp or sweep
  // a deactivated or test agent (L274).
  for (const w of plan.attributeWrites) {
    if (!(w.changes.debtTeams.changed || w.changes.backendServices.changed)) continue;
    const r = rosterById.get(w.userId);
    if (!r || r.deactivated || r.isTest || flipped.has(w.userId)) continue;
    tierEvaluated.add(w.userId);
    evals.push({ userId: w.userId, email: w.email, before: r.attributes, after: w.attributes, changes: w.changes });
  }

  // A pending demotion mark on a row the tier loop did NOT evaluate: sweep it once aged, or clear
  // it if resolved. Its `after` is the write this sync is making if there is one (so the decision
  // judges the attributes about to be stored, e.g. a redistribute-tag change), else its stored
  // attributes. Rows being redistribute-flipped are skipped (their full sweep covers everything).
  for (const r of roster) {
    if (r.deactivated || r.isTest || flipped.has(r.id) || tierEvaluated.has(r.id)) continue;
    if (storedDemotionStamp(r.attributes) === null) continue;
    const w = writesByUser.get(r.id);
    evals.push({
      userId: r.id,
      email: r.email,
      before: r.attributes,
      after: w ? w.attributes : r.attributes ?? {},
      // A non-tier write for this row is still applied by the base loop and counted there, so the
      // sweep/clear carries no base changes of its own.
      changes: null,
    });
  }

  return evals;
}

/**
 * Resolve the demotion trigger over a roster plan (#3582, Phase 3): read each evaluated agent's
 * bookings and decide with `planDemotionAction`. A STAMP becomes an overlay on the core tier
 * write (so it lands in the same write as the tiers); a SWEEP or CLEAR becomes a separate write
 * that cannot lose the core change if it fails.
 *
 * EACH AGENT IS ITS OWN FAILURE BOUNDARY. The candidate read fails loud on a short or failed read
 * (`criteriaMapOrThrow`, `unwrap`), and this is an AUXILIARY pass on top of the core roster sync:
 * one agent's failing read must never abort the run and leave the redistribute flips and attribute
 * writes unapplied (L73, L71). A throw is logged, counted, and the agent skipped. The core tier
 * write is NEVER withheld (that would let a persistent read fault block an agent's routing facts);
 * instead, if it was a tier-changed row whose attributes MAY have narrowed and has no mark yet, it
 * is stamped DEFENSIVELY so the narrowing is kept for the next sync's sweep pass to confirm (L648).
 */
export async function resolveDemotionWrites(
  roster: TwilioRosterRow[],
  plan: RedistributePlan,
  loadRerouteCandidates: (userId: string) => Promise<RerouteCandidate[]>,
  nowIso: string,
): Promise<DemotionResolution> {
  const stampOverlays = new Map<string, Attributes>();
  const sweepClearWrites: DemotionWrite[] = [];
  let evalFailures = 0;

  for (const e of demotionEvalList(roster, plan)) {
    try {
      const candidates = await loadRerouteCandidates(e.userId);
      const action = planDemotionAction(e.before, e.after, candidates, nowIso);
      const applied = applyDemotionAction(e.after, action, nowIso);
      if (!applied) continue;
      if (action.kind === "stamp") {
        // The stamp rides in the core tier write (this row is always a tier-changed one).
        stampOverlays.set(e.userId, applied.attributes);
      } else if (action.kind === "sweep-overdue" || action.kind === "clear") {
        sweepClearWrites.push({
          userId: e.userId,
          email: e.email,
          attributes: applied.attributes,
          sweepMarkedAtIso: applied.sweepMarkedAtIso,
          kind: action.kind,
        });
      }
    } catch (err) {
      evalFailures++;
      // The core tier write is NEVER withheld on a failure: that would let a persistent read fault
      // (a missing bucket, say) block the agent's routing facts for good. Instead, when the read
      // failed but the attributes MAY have narrowed and there is no mark yet, stamp DEFENSIVELY so
      // the narrowing is not written away. The next sync's sweep pass reads the bookings and either
      // sweeps the lost set or clears the stamp if the agent in fact still serves them (L648).
      if (e.changes !== null && storedDemotionStamp(e.before) === null && mayNarrowEligibility(e.before, e.after)) {
        stampOverlays.set(e.userId, withDemotionMark(e.after, nowIso, demotionTiersOf(e.before)));
      }
      log.error(
        "twilio-sync",
        { msg: "demotion evaluation failed for one agent, carrying on", user_id: e.userId },
        err,
      );
    }
  }

  return { stampOverlays, sweepClearWrites, evalFailures };
}
