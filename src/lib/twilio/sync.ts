// The Twilio half of the hourly roster job (#2097).
//
// Twilio TaskRouter is where managers actually tag agents, and it is what feeds
// cal.com. `Redistribute` means the agent should not be taking booked calls (Dan,
// 2026-09-08) and exists nowhere else, so this is the only way Slate can learn it.
//
// SINCE #2152 IT ALSO WRITES THE ROUTING ATTRIBUTES THEMSELVES. Debt tiers and
// backend service used to come from Salesforce booleans while cal.com took them
// from these same tags, so the agreement between the two was maintained by whoever
// kept both in step (Dan, 2026-09-09: "let's use twilio as the source of truth").
// A person's memory is not a mechanism, so the tags are read here and written onto
// `users.attributes`, and `pnpm verify:twilio-parity` agrees by construction about
// those facts, leaving it the roster membership half to answer.
//
// EVERY FLIP GOES THROUGH `applyBookable`, never a direct update. Leaving the pool
// also has to stop the agent's Google calendar watches and prune their cached busy
// time (#239/#248), and it is where the audit row and the log line come from. A raw
// write would leave Google notifying Slate about somebody it no longer books.
//
// THE ORDER OF EACH FLIP'S TWO WRITES IS THE CRASH SAFETY, and the two directions
// are deliberately opposite (assume it runs twice):
//
//  - turning somebody OFF writes the mark FIRST. A crash in between leaves a
//    bookable agent who is marked, and the planner turns them off again next hour.
//  - turning them back ON flips FIRST and clears the mark only once the flip
//    SETTLED. A crash in between leaves a bookable agent still marked, which the
//    planner plans again and the flip settles as a noop. Clearing the mark first
//    would drop a refused agent out of the feature for good, and a refusal is the
//    expected case: the activation gate turns down anybody with no reachable Google
//    calendar.
//
// TAKING SOMEBODY OUT OF THE POOL STRANDS WHAT THEY HAVE BOOKED, so the same coverage
// sweep the offboarding automation does moves it (#2115, Dan 2026-09-09). The admin
// toggle asks a person to confirm first; this has nobody to ask, so it takes the sweep
// rather than the question. After cutover Slate holds the real book and this is what
// stops a lead's call sitting with an agent who can no longer be routed to.
//
// The sweep is DEBOUNCED (#3599): it does NOT fire on the turn-off. Moving a customer's
// booked call is disruptive and not cheap to undo, so the first sight only takes the
// agent out of the pool (reversible, moves no call) and the sweep waits for the
// `sweep-overdue` flip on a LATER sync, once the stored mark has aged past the debounce
// window. A tag that flaps off within the hour is undone by `turn-back-on` before a
// single call moved. The `sweep-overdue` runs the sweep BEFORE recording it done, the
// same assume-it-runs-twice ordering as the mark: a crash in between re-plans and
// converges on the one job by its unique key. Between the turn-off and the sweep the
// agent is out of the pool but still holds their calls by design, which
// `inactive_agent_bookings` is told to tolerate via `redistributeSweepPending`.
//
// COST, derived rather than assumed: one Twilio call for the whole roster (142
// workers against a page size of 200), one roster read, and per flip about 6
// subrequests through the bookable service. The twelve agent backlog this ships
// against is one run of roughly 80; steady state is nought or one flip an hour.
// Subrequests are not a constraint at the 10,000 ceiling
// (`docs/cloudflare-platform-notes.md`), and no per run cap is imposed because a cap
// would hide a backlog rather than report one.
import { fetchTwilioWorkers, TwilioReadError } from "@/lib/twilio/client";
import { mergeWorkers, readWorker, type TwilioSide } from "@/lib/twilio/roster";
import {
  changesAnything,
  planTwilioRoster,
  type TwilioChanges,
  type TwilioRosterRow,
} from "@/lib/twilio/roster-plan";
import { applyBookableByUserId, type BookableResult } from "@/lib/bookable/service";
import {
  activationAllowance,
  type ActivationAllowance,
} from "@/lib/bookable/activation-allowance";
import { startBulkReassign } from "@/lib/booking/service";
import { demotionBookings, rerouteCandidatesForAgent } from "@/lib/booking/bulk-reassign-store";
import { readDemotionRerouteEnabled } from "@/lib/booking/settings";
import { resolveDemotionWrites } from "@/lib/twilio/demotion-trigger";
import { DEMOTION_SWEEP_REASON, demotionChangeOf, type DemotionChange } from "@/lib/booking/demotion-plan";

import type { RerouteCandidate } from "@/lib/booking/reroute-eligibility";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { ensureDefaultOrg } from "@/lib/provision";
import { recordAudit } from "@/lib/audit";
import { log } from "@/lib/log";
import type { Attributes } from "@/lib/db/types";
import { withoutPlaceholder } from "@/lib/advisors/real-advisor";
import type { TwilioWorker } from "@/lib/twilio/client";

/** One demotion sweep queued this run (#3582), with what changed (#3615) so the run's report can
 *  say who lost what and point at the undo. */
export interface DemotionSweepReport {
  email: string;
  userId: string;
  /** The sweep, so the report can open the agent's page ON it, where its moves are listed. */
  jobId: string;
  bookings: number;
  change: DemotionChange | null;
}

export interface TwilioSyncDeps {
  orgId: string;
  /**
   * How many activations this ROSTER RUN may still attempt (#2302), shared with the
   * Salesforce half so the two cannot each spend the whole invocation budget.
   */
  allowance: ActivationAllowance;
  /** Injected, so the stamp a flip is keyed on is one value a test can assert on. */
  nowIso: () => string;
  /**
   * Queue the coverage sweep that moves what the agent already has booked (#2115),
   * on the debounced `sweep-overdue` flip rather than the turn-off (#3599).
   *
   * Idempotent on `markedAtIso` by a database unique index, so a run that dies between
   * the sweep and the marker that records it done re-plans and converges on ONE sweep
   * rather than moving customers' bookings twice. `markedAtIso` is the stamp the
   * turn-off stored, so the overdue sweep keys onto the same job the turn-off would have.
   */
  startCoverageSweep: (input: {
    outUserId: string;
    markedAtIso: string;
  }) => Promise<{ itemCount: number }>;
  /**
   * Whether the reroute-on-ineligibility trigger is armed (#3582), read once per run from
   * `booking_settings.demotion_reroute_enabled`. When false the whole demotion lifecycle is
   * skipped: no candidates are read, nothing is stamped, swept or cleared, and the run behaves
   * exactly as it did before the feature. Null means the switch could not be READ (#3615): the
   * run treats it as off, so an unreadable switch never moves a customer's booking, and reports
   * it as `demotionSwitchUnreadable` so a switch that cannot be read is not a silent hour.
   */
  demotionEnabled: boolean | null;
  /**
   * An agent's upcoming bookings as reroute candidates, for the demotion DECISION (#3582): the
   * trigger runs `bookingsToReroute` over every held booking. Only called for an evaluated agent
   * while `demotionEnabled` is true.
   */
  loadRerouteCandidates: (userId: string) => Promise<RerouteCandidate[]>;
  /**
   * Queue the PARTIAL coverage sweep for a tier/backend demotion (#3582): moves only the
   * bookings the agent no longer serves, keyed idempotently on `markedAtIso` so a crashed or
   * re-run sync converges on ONE job. The sibling of `startCoverageSweep` (the full pool exit).
   */
  startDemotionSweep: (input: {
    outUserId: string;
    markedAtIso: string;
    /** The agent's eligibility as the decision saw it (the narrowed `after`), used to FILTER the
     *  snapshot. Passed rather than re-read, because the narrowed attributes may not be written
     *  yet when the enqueue runs (the swept-marker write comes after it). */
    attributes: Attributes | null;
    /** What the demotion changed (#3615): the tiers saved at the stamp and the ones the sweep acts
     *  on, recorded on the job at the moment it decides to move anybody. Null for a mark stamped
     *  before the earlier tiers were saved. */
    change: DemotionChange | null;
  }) => Promise<{ itemCount: number; jobId: string }>;
  fetchWorkers: () => Promise<TwilioWorker[]>;
  loadRoster: () => Promise<TwilioRosterRow[]>;
  applyBookable: (userId: string, bookable: boolean) => Promise<BookableResult>;
  /**
   * The row's attributes, and optionally the pending mark, in ONE write.
   *
   * An object rather than positional arguments, because the two are the same shape
   * at the call site and a swapped pair reads as correct (the #1587 lesson). The
   * mark travels WITH the attributes on purpose: it records that a flip was asked
   * for, so a run that dies between the two leaves an intent the next hour retries
   * rather than a tier nobody acted on.
   */
  writeAttributes: (input: {
    userId: string;
    attributes: Attributes;
    bookablePendingSince?: string;
  }) => Promise<void>;
  recordAudit: typeof recordAudit;
}

export interface TwilioSyncResult {
  /** How many workers Twilio answered with. Zero never gets this far. */
  workers: number;
  /** How many distinct addresses those workers covered. */
  addresses: number;
  /** Emails taken out of the bookable pool because Twilio carries the tag. */
  turnedOff: string[];
  /** Emails put back in because Twilio no longer carries it. */
  turnedBackOn: string[];
  /**
   * Emails whose reactivation the activation gate REFUSED, because they have no
   * reachable Google calendar. The mark survives and next hour tries again.
   *
   * Counted so the person who pressed sync reads it on the page rather than
   * learning it from Slack an hour later (Dan, 2026-09-08).
   */
  reactivationRefused: string[];
  /**
   * Planned for reactivation and NOT attempted this run, because the roster run's
   * shared activation allowance was spent (#2302). Nobody here was admitted with an
   * unread calendar: they keep their mark and the next run picks them up. Named
   * rather than counted, so the next run can be checked against these addresses.
   */
  reactivationDeferred: string[];
  /** Marked by Slate, and Twilio holds no worker for them, so nothing was done. */
  markedWithNoWorker: string[];
  /**
   * Emails whose debt tiers or backend service were rewritten from their Twilio
   * tags (#2152), counted only once the write LANDED.
   *
   * Separate counts because they send a reader to different places: a tier decides
   * which of the sixty buckets somebody is in, and the backend decides which flow
   * reaches them at all.
   */
  tiersChanged: string[];
  backendChanged: string[];
  /**
   * Emails whose mirrored `Redistribute` tag LANDED this run, and emails whose tag
   * was CLEARED (#2735), each counted only once the write landed.
   *
   * Named apart from the flips because the tag reaches further than the pool: it is
   * what exempts somebody from the Regal call page, so a run that moved it silenced
   * or reopened a pager, and that has to be readable in the run's own report rather
   * than inferred from the absence of a page. A junk spelling being tidied is in
   * neither list, since nothing a reader sees changed.
   */
  redistributeTagLanded: string[];
  redistributeTagCleared: string[];

  /**
   * Every in scope Slate row Twilio holds no worker for.
   *
   * No fact about them is written, only the `twilio_worker_missing_since` stamp that
   * records the absence (#2735). This is also the only visible shape of a PARTIAL
   * Twilio read: a read that returned nothing is refused outright, and one that
   * returned half the roster would quietly exclude the other half.
   */
  withoutWorker: string[];
  /**
   * The coverage sweeps queued for agents this run took out of the pool, and how
   * many calls each one took (#2115).
   *
   * An agent holding NOTHING produces no entry, which is not the same as a sweep
   * that could not be queued: those are counted apart, so "found nothing" and
   * "could not look" are never one number (L98, L11).
   */
  coverageSweeps: { email: string; bookings: number }[];
  /**
   * Overdue coverage sweeps that threw (#3599). The sweep runs on its own later sync,
   * after the agent is already out of the pool, so there is no flip to hold back here.
   *
   * A throw leaves the swept marker UNWRITTEN, so the next sync re-plans the
   * sweep-overdue and tries again; the calls held meanwhile are caught by
   * `inactive_agent_bookings`, which watches for exactly a not bookable agent still
   * holding appointments once the pending-sweep grace lapses.
   */
  coverageSweepFailures: number;
  /**
   * Attribute writes that threw, so the run carried on with the rest (L73).
   *
   * Its own count rather than folded into `flipFailures`, because the two send a
   * reader to different places: a flip failure leaves somebody bookable who should
   * not be, and this leaves a stored value the next hour will write again.
   */
  attributeWriteFailures: number;
  /** Workers whose `attributes` string is not JSON: a fault in Twilio's data. */
  corruptAttributes: number;
  /** Valid JSON carrying no email, which is usually a queue entity and ordinary. */
  noEmail: number;
  /** Tags this mapping does not know, reported so a new tier is never invisible. */
  unmappedTags: string[];
  /**
   * Flips that threw, so the run carried on with the rest (L73).
   *
   * Counted rather than swallowed, and NOT added to `turnedOff` or `turnedBackOn`,
   * because a report of twelve agents taken out of the pool is the only evidence
   * anybody will look at and one of those twelve still being bookable is the whole
   * fault. The outcome is paged by `bookable-not-routable` (#2088), which watches for
   * an agent who is bookable in Slate and withheld in cal.com whatever the cause; the
   * next hour retries, since the plan is a pure function of the current state.
   */
  flipFailures: number;
  /** Emails the demotion trigger stamped this run (a confirmed tier/backend narrowing), counted
   *  once the stamping write landed (#3582). Empty when the trigger is off. */
  demotionStamped: string[];
  /** Emails whose demotion sweep was queued this run, once the stamp aged past the debounce and
   *  the agent still could not serve a held booking (#3582). */
  demotionSwept: string[];
  /** Emails whose demotion mark was cleared this run (re-widened or the booking already moved),
   *  so a flapped narrowing moves nobody (#3582). */
  demotionCleared: string[];
  /** The demotion sweeps queued this run and how many bookings each moved, the partial sibling
   *  of `coverageSweeps` (#3582). An agent with nothing to move produces no entry. */
  demotionSweeps: DemotionSweepReport[];
  /** Demotion sweeps that threw while queueing, so the swept marker was withheld and the next
   *  sync retries; calls held meanwhile are caught by `inactive_agent_bookings` (#3582). */
  demotionSweepFailures: number;
  /** Demotion attribute writes (stamp / swept marker / clear) that threw, so the run carried on
   *  with the rest and the next sync re-plans (#3582, L73). */
  demotionWriteFailures: number;
  /** Agents whose demotion DECISION threw (a failed candidate/criteria read), skipped so the
   *  auxiliary demotion pass could never abort the core roster sync (#3582, L73). */
  demotionEvalFailures: number;
  /** The reroute switch could not be read this run (#3615), so the demotion trigger checked
   *  nobody. Kept apart from a switch read as off, which is a healthy hour. */
  demotionSwitchUnreadable: boolean;
}

/**
 * Read Twilio, flip whoever changed, and say what happened.
 *
 * THROWS on every way of learning nothing: the read's five refusals come straight
 * back out by name, and a roster read that produced no rows is refused here for the
 * mirror reason. The caller turns that into an alert and a banner line; what it must
 * never do is treat it as a quiet run, because a Twilio half that silently does
 * nothing has every symptom of a healthy one.
 */
export async function syncTwilioRedistribute(deps: TwilioSyncDeps): Promise<TwilioSyncResult> {
  const workers = await deps.fetchWorkers();

  const byEmail = new Map<string, TwilioSide[]>();
  // Counted apart, because they are different faults and one message cannot name
  // both honestly (L11).
  let corruptAttributes = 0;
  let noEmail = 0;
  for (const w of workers) {
    const read = readWorker(w.attributes);
    if (!read.ok) {
      if (read.why === "unreadable-attributes") corruptAttributes++;
      else noEmail++;
      continue;
    }
    byEmail.set(read.side.email, [...(byEmail.get(read.side.email) ?? []), read.side]);
  }
  // Duplicates are unioned, exactly as the Pipedream job unions them, so this acts
  // on what cal.com actually receives. The duplication itself is a Twilio
  // configuration fault and is reported by `pnpm verify:twilio-parity` (exit 12).
  const merged = new Map<string, TwilioSide>();
  for (const [email, sides] of byEmail) merged.set(email, mergeWorkers(sides).merged);

  const roster = await deps.loadRoster();
  if (roster.length === 0) {
    // The mirror of the client's empty listing refusal. An empty roster makes every
    // marked agent look absent from Slate, flips nobody, and reports a clean run
    // (L98).
    throw new Error("Twilio sync read no Slate users at all, so nothing was judged and no agent was flipped");
  }

  const plan = planTwilioRoster(roster, merged, deps.nowIso());
  const turnedOff: string[] = [];
  const turnedBackOn: string[] = [];
  const reactivationRefused: string[] = [];
  const reactivationDeferred: string[] = [];
  const tiersChanged: string[] = [];
  const backendChanged: string[] = [];
  const redistributeTagLanded: string[] = [];
  const redistributeTagCleared: string[] = [];
  const landed: Landed = { tiersChanged, backendChanged, redistributeTagLanded, redistributeTagCleared };
  const coverageSweeps: { email: string; bookings: number }[] = [];
  const counters = { coverageSweepFailures: 0, heldWriteFailures: 0 };
  const demotionStamped: string[] = [];
  const demotionSwept: string[] = [];
  const demotionCleared: string[] = [];
  const demotionSweeps: DemotionSweepReport[] = [];
  let demotionSweepFailures = 0;
  let demotionWriteFailures = 0;

  // The demotion lifecycle (#3582), gated OFF by default. When off, nothing here runs: no
  // candidates are read and the run behaves exactly as before. When on, a NEW stamp is folded
  // into the core tier write (so it lands in the same write as the tiers), while a sweep or clear
  // is a SEPARATE write applied after the core loop, so a demotion failure can never lose the core
  // tier change.
  const demotion = deps.demotionEnabled === true
    ? await resolveDemotionWrites(roster, plan, deps.loadRerouteCandidates, deps.nowIso())
    : { stampOverlays: new Map<string, Attributes>(), sweepClearWrites: [], evalFailures: 0 };
  const demotionEvalFailures = demotion.evalFailures;

  let flipFailures = 0;
  for (const flip of plan.flips) {
    // Its own boundary. This ships against a backlog of twelve, so one agent whose
    // flip throws (a database blip, a Google refusal the service does not catch) must
    // not leave the other eleven bookable while the run reports a Twilio read
    // failure, which is a different fault in a different system.
    try {
      await runFlip(flip, deps, {
        turnedOff,
        turnedBackOn,
        reactivationRefused,
        reactivationDeferred,
        landed,
        coverageSweeps,
        counters,
      });
    } catch (err) {
      flipFailures++;
      log.error("twilio-sync", { msg: "flip failed, carrying on with the rest", user_id: flip.userId, action: flip.action }, err);
    }
  }

  // The attributes for everybody the run is not flipping. Their own boundary, one
  // row at a time, for the same reason the flips have one: this is the write that
  // touches the WHOLE roster, so one bad row must not take the rest with it.
  let attributeWriteFailures = 0;
  for (const write of plan.attributeWrites) {
    // A demotion stamp (confirmed, or defensive when the decision's read failed) rides in THIS
    // write, so it lands in the same write as the tiers that caused it (crash-safe). The core tier
    // write is never withheld: a demotion-read failure must not block an agent's routing facts. An
    // existing stamp is already carried in write.attributes.
    const overlay = demotion.stampOverlays.get(write.userId);
    try {
      await deps.writeAttributes({ userId: write.userId, attributes: overlay ?? write.attributes });
      countLanded(write.email, write.changes, landed);
      if (overlay) demotionStamped.push(write.email);
    } catch (err) {
      attributeWriteFailures++;
      log.error("twilio-sync", { msg: "attribute write failed, carrying on", user_id: write.userId }, err);
    }
  }

  // The demotion sweep/clear writes (#3582), SEPARATE from the core tier write above so a failure
  // here can never lose a tier change. Each is its own boundary. A sweep ENQUEUES BEFORE writing
  // its swept marker, the crash-safe order the redistribute sweep uses: a run that dies in between
  // re-plans next sync and converges on the one job by its unique key, where recording it done
  // first would log a sweep that never ran.
  for (const dw of demotion.sweepClearWrites) {
    try {
      if (dw.sweepMarkedAtIso) {
        try {
          const change = demotionChangeOf(dw.attributes);
          const { itemCount, jobId } = await deps.startDemotionSweep({
            outUserId: dw.userId,
            markedAtIso: dw.sweepMarkedAtIso,
            attributes: dw.attributes,
            change,
          });
          if (itemCount > 0) demotionSweeps.push({ email: dw.email, userId: dw.userId, jobId, bookings: itemCount, change });
        } catch (err) {
          demotionSweepFailures++;
          log.error(
            "twilio-sync",
            { msg: "demotion sweep could not be queued, next sync will retry", user_id: dw.userId },
            err,
          );
          // Swept marker withheld, so the next sync re-plans and retries. Calls held meanwhile
          // are caught by `inactive_agent_bookings` via the demotion-pending grace.
          continue;
        }
      }
      await deps.writeAttributes({ userId: dw.userId, attributes: dw.attributes });
      if (dw.kind === "sweep-overdue") demotionSwept.push(dw.email);
      else demotionCleared.push(dw.email);
    } catch (err) {
      demotionWriteFailures++;
      log.error("twilio-sync", { msg: "demotion write failed, carrying on", user_id: dw.userId }, err);
    }
  }

  const unmappedTags = [...new Set([...merged.values()].flatMap((s) => s.unmappedTags))].sort();
  if (unmappedTags.length > 0) {
    // Logged rather than put in the admin banner. A tag nobody mapped is Twilio
    // configuration a manager cannot act on from the roster page, and
    // `pnpm verify:twilio-parity` already reports it as its own verdict (exit 13);
    // saying it in both places would be the same fact twice (L605).
    log.warn("twilio-sync", { msg: "Twilio tags this mapping does not know", tags: unmappedTags.join(", ") });
  }
  if (plan.withoutWorker.length > 0) {
    // Not in the admin banner. A Slate row with no Twilio worker is Twilio
    // configuration a manager cannot act on from the roster page, and the count
    // matters most when it is LARGE, which is what a partial read looks like.
    log.warn("twilio-sync", {
      msg: "Slate rows Twilio holds no worker for, whose stored values were left as they are",
      count: plan.withoutWorker.length,
    });
  }
  if (redistributeTagLanded.length > 0 || redistributeTagCleared.length > 0) {
    // Logged as well as returned, because the cron run's result is read by nobody
    // unless something goes wrong, and this is the fact that silences a pager.
    log.info("twilio-sync", {
      msg: "Redistribute tag moved",
      landed: redistributeTagLanded.length,
      cleared: redistributeTagCleared.length,
    });
  }
  if (plan.markedWithNoWorker.length > 0) {
    log.warn("twilio-sync", {
      msg: "marked redistribute and Twilio holds no worker for them, so nothing was done",
      count: plan.markedWithNoWorker.length,
    });
  }

  return {
    workers: workers.length,
    addresses: merged.size,
    turnedOff,
    turnedBackOn,
    reactivationRefused,
    reactivationDeferred,
    markedWithNoWorker: plan.markedWithNoWorker,
    coverageSweeps,
    coverageSweepFailures: counters.coverageSweepFailures,
    tiersChanged,
    backendChanged,
    redistributeTagLanded,
    redistributeTagCleared,
    withoutWorker: plan.withoutWorker,
    attributeWriteFailures: attributeWriteFailures + counters.heldWriteFailures,
    corruptAttributes,
    noEmail,
    unmappedTags,
    flipFailures,
    demotionStamped,
    demotionSwept,
    demotionCleared,
    demotionSweeps,
    demotionSweepFailures,
    demotionWriteFailures,
    demotionEvalFailures,
    demotionSwitchUnreadable: deps.demotionEnabled === null,
  };
}

/**
 * Where each fact's count lands, once its write has actually landed (L12).
 *
 * One object rather than four arrays threaded through two call sites, because the
 * flip path and the plain write path must count the same way: a fact counted in one
 * and not the other is a report that is true of half the roster.
 */
interface Landed {
  tiersChanged: string[];
  backendChanged: string[];
  redistributeTagLanded: string[];
  redistributeTagCleared: string[];
}

/**
 * Count what this row's write moved, and nothing it did not.
 *
 * Called only AFTER the write returns. Counting at plan time would report every
 * agent whose payload was built, including the ones whose write threw, and the
 * counts are the only evidence anybody reads (#1134).
 */
function countLanded(email: string, changes: TwilioChanges, out: Landed): void {
  if (changes.debtTeams.changed) out.tiersChanged.push(email);
  if (changes.backendServices.changed) out.backendChanged.push(email);
  // Judged on the READING before and after, never on `changed` alone, which is also
  // true when a junk spelling is tidied and nobody's exemption moved.
  const tag = changes.redistributeTagged;
  if (tag.value && !tag.wasTagged) out.redistributeTagLanded.push(email);
  if (!tag.value && tag.wasTagged) out.redistributeTagCleared.push(email);
}

/**
 * A reactivation that did not settle still owes the Twilio facts it carried, with
 * the mark KEPT so the retry survives (#2724).
 *
 * Without this, a tag that came off stayed stored as present for as long as the
 * activation gate kept refusing, and the Regal call detector went on exempting the
 * person, which the issue names directly: the tag coming off ends the exemption.
 * Nothing is written when nothing moved, which is the common case.
 */
async function writeHeld(
  flip: ReturnType<typeof planTwilioRoster>["flips"][number],
  deps: TwilioSyncDeps,
  countLanded_: () => void,
  counters: { heldWriteFailures: number },
): Promise<void> {
  if (!flip.heldAttributes || !changesAnything(flip.changes)) return;
  // Its own boundary (L73): the refusal or deferral is already reported, so a
  // throw here is an attribute write failure, never also a failed flip.
  try {
    await deps.writeAttributes({ userId: flip.userId, attributes: flip.heldAttributes });
    countLanded_();
  } catch (err) {
    counters.heldWriteFailures++;
    log.error("twilio-sync", { msg: "held attribute write failed, carrying on", user_id: flip.userId }, err);
  }
}

/** One flip, both directions, with the two writes in the order the header explains. */
async function runFlip(
  flip: ReturnType<typeof planTwilioRoster>["flips"][number],
  deps: TwilioSyncDeps,
  out: {
    turnedOff: string[];
    turnedBackOn: string[];
    reactivationRefused: string[];
    reactivationDeferred: string[];
    landed: Landed;
    coverageSweeps: { email: string; bookings: number }[];
    counters: { coverageSweepFailures: number; heldWriteFailures: number };
  },
): Promise<void> {
  // Counted where the write LANDS, never where it is planned, so a payload that
  // never reached the database cannot be reported as a value that changed.
  const countLanded_ = () => countLanded(flip.email, flip.changes, out.landed);

  if (flip.action === "turn-off") {
    // Mark first, then the flip. The legal value rides in the SAME payload rather than
    // a second write over the same column, which would build from a base this one has
    // already changed (L443). The coverage sweep is NOT here: moving a customer's call
    // is disruptive and not cheap to undo, so it waits for the `sweep-overdue` path
    // below, on a later sync once the mark has aged past the debounce window (#3599).
    // The first sight only takes them out of the pool, which is reversible, so a tag
    // that flaps off within the hour is undone by `turn-back-on` with no call moved.
    await deps.writeAttributes({ userId: flip.userId, attributes: flip.attributes });
    countLanded_();
    const result = await deps.applyBookable(flip.userId, false);
    if (result.status === "applied") {
      out.turnedOff.push(flip.email);
      await deps.recordAudit({
        orgId: deps.orgId,
        actorId: null,
        action: "agent.bookable",
        targetUserId: flip.userId,
        details: { bookable: false, via: "twilio-sync", reason: "redistribute" },
      });
    } else if (result.status !== "noop") {
      // A flip the service could not perform. Said rather than counted as done,
      // because a report of twelve agents turned off is the only evidence anybody
      // will look at.
      log.warn("twilio-sync", { msg: "flip out of the pool did not apply", user_id: flip.userId, status: result.status });
    }
    return;
  }

  if (flip.action === "sweep-overdue") {
    // The debounce has elapsed (#3599): the agent is already out of the pool from a
    // prior turn-off, still tagged, and the mark it stored has aged past the window, so
    // the booked calls move now. The sweep goes BEFORE the marker that records it done.
    // That order is the crash safety: a run that dies between them leaves the agent
    // tagged and NOT yet marked swept, whom the next sync re-plans, reads the SAME
    // stamp from, and converges onto the same job by its unique key. Recording it done
    // first, a crash in between would log a sweep that never ran and the next sync would
    // skip it. The flip itself already happened, so there is nothing to apply or audit.
    if (!flip.markedAtIso) return;
    try {
      const { itemCount } = await deps.startCoverageSweep({
        outUserId: flip.userId,
        markedAtIso: flip.markedAtIso,
      });
      if (itemCount > 0) out.coverageSweeps.push({ email: flip.email, bookings: itemCount });
    } catch (err) {
      out.counters.coverageSweepFailures++;
      log.error(
        "twilio-sync",
        { msg: "overdue coverage sweep could not be queued, next sync will retry", user_id: flip.userId },
        err,
      );
      // Marker withheld, so the next sync re-plans and retries. Calls left behind
      // meanwhile are caught by `inactive_agent_bookings`.
      return;
    }
    // Record the sweep as done only now it has landed, so it fires once.
    await deps.writeAttributes({ userId: flip.userId, attributes: flip.attributes });
    countLanded_();
    return;
  }

  // #2302: a flip INTO the pool now reads the agent's calendar as part of the gate,
  // which is several Google calls out of an invocation this sync shares with the
  // Salesforce roster sync. Slots come from ONE allowance held by the roster run, so
  // the two halves cannot each spend the whole budget.
  //
  // Only this direction. Turning somebody off is never held back: an agent Twilio
  // withholds who is still bookable misroutes a lead today, and no budget argument
  // outranks that.
  if (!deps.allowance.take()) {
    out.reactivationDeferred.push(flip.email);
    log.info("twilio-sync", {
      msg: "reactivation left for the next run, this run's activation allowance is spent",
      user_id: flip.userId,
    });
    await writeHeld(flip, deps, countLanded_, out.counters);
    return;
  }

  // Flip first, and clear the mark only once it settled.
  const result = await deps.applyBookable(flip.userId, true);
  if (result.status === "blocked") {
    out.reactivationRefused.push(flip.email);
    log.warn("twilio-sync", {
      msg: "reactivation refused, mark kept for next hour",
      user_id: flip.userId,
      reason: result.reason,
    });
    await writeHeld(flip, deps, countLanded_, out.counters);
    return;
  }
  if (result.status === "not_found") {
    log.warn("twilio-sync", { msg: "flip into the pool found no row", user_id: flip.userId });
    return;
  }
  await deps.writeAttributes({ userId: flip.userId, attributes: flip.attributes });
  countLanded_();
  // A noop is a STALE MARK, not a change: somebody an admin had already turned
  // back on. The mark still had to go, and nothing else changed, so it is neither
  // reported as a flip nor audited.
  if (result.status === "applied") {
    out.turnedBackOn.push(flip.email);
    await deps.recordAudit({
      orgId: deps.orgId,
      actorId: null,
      action: "agent.bookable",
      targetUserId: flip.userId,
      details: { bookable: true, via: "twilio-sync", reason: "redistribute-removed" },
    });
  }
}

/**
 * The production wiring: live Twilio, the live roster, the shared bookable service.
 *
 * The roster read takes `attributes` because the flip's write is a read modify write
 * over them, and `unwrap` rather than a swallowed error because an empty answer here
 * is indistinguishable from a roster where nobody is tagged (#277, L105).
 */
export async function defaultTwilioSyncDeps(orgId?: string): Promise<TwilioSyncDeps> {
  const id = orgId ?? (await ensureDefaultOrg()).id;
  return {
    orgId: id,
    nowIso: () => new Date().toISOString(),
    // The same sweep the offboarding automation queues (#1241) and the admin
    // coverage panel starts, so an agent leaving the pool is covered identically
    // whichever thing took them out of it. No human actor: nobody is present in an
    // hourly cron tick, and `redistributeMarkedAtIso` is the record of WHY there is
    // none, which is what `coverageSweepActor` reads.
    startCoverageSweep: async ({ outUserId, markedAtIso }) => {
      const { itemCount } = await startBulkReassign({
        outUserId,
        // Open ended, from the moment Slate marked them: everything still ahead of
        // them is theirs no longer. `coverageSelectionBounds` still refuses to move
        // an appointment already under way.
        rangeStartIso: markedAtIso,
        rangeEndIso: null,
        reason: { code: "coverage", detail: null },
        actor: null,
        redistributeMarkedAtIso: markedAtIso,
      });
      return { itemCount };
    },
    // Read once per run. Off by default, so the whole demotion lifecycle below stays inert until
    // an admin arms it (#3582). An unreadable switch answers null (#3615): treated as off, so it
    // never moves a booking, and reported, so it is never a silent hour.
    demotionEnabled: await readDemotionRerouteEnabled(),
    loadRerouteCandidates: (userId) =>
      // Open ended from now: everything still ahead of the agent. The window rule is shared with
      // the snapshot, so the decision and the move judge the same bookings (L342).
      rerouteCandidatesForAgent(userId, new Date().toISOString(), null),
    // The PARTIAL sibling of startCoverageSweep (#3582): a system-initiated sweep keyed on the
    // demotion mark, moving only the FILTERED set the agent no longer serves (demotionBookings),
    // never the full coverage read.
    startDemotionSweep: async ({ outUserId, markedAtIso, attributes, change }) => {
      const { itemCount, jobId } = await startBulkReassign({
        outUserId,
        rangeStartIso: markedAtIso,
        rangeEndIso: null,
        reason: DEMOTION_SWEEP_REASON,
        actor: null,
        demotionMarkedAtIso: markedAtIso,
        demotionChange: change,
        // Filter by the decision's attributes, not a fresh DB read (see demotionBookings).
        snapshotBookings: () => demotionBookings(outUserId, markedAtIso, null, attributes),
      });
      return { itemCount, jobId };
    },
    fetchWorkers: () => fetchTwilioWorkers(),
    loadRoster: async () => {
      // cap-safe: users is a roster-bounded table, ~148 rows against a 200-agent design target
      // #4201: never the placeholder advisor, which has no Twilio worker to read or tag.
      const rows = (unwrap(
        await withoutPlaceholder(
          supabaseAdmin()
            .from("users")
            .select("id, email, bookable, deactivated_at, bookable_pending_since, is_test, attributes")
            .eq("org_id", id),
        ),
        "twilio-sync.roster",
      ) ?? []) as {
        id: string;
        email: string;
        bookable: boolean;
        deactivated_at: string | null;
        bookable_pending_since: string | null;
        is_test: boolean;
        attributes: Attributes | null;
      }[];
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        bookable: r.bookable === true,
        deactivated: r.deactivated_at !== null,
        pending: r.bookable_pending_since !== null,
        isTest: r.is_test === true,
        attributes: r.attributes,
      }));
    },
    // #3028: this sync flips somebody in only when it has just read their worker
    // LIVE and found no Redistribute tag, and it rewrites the stored copy of the tag
    // only AFTER the flip settles. The service refuses on the stored copy, so it is
    // told the live read overrules it; otherwise every reactivation would be refused
    // for an hour and reported as refused.
    applyBookable: (userId, bookable) =>
      applyBookableByUserId(userId, bookable, undefined, { liveTwilioUntagged: true }),
    allowance: activationAllowance(),
    writeAttributes: async ({ userId, attributes, bookablePendingSince }) => {
      const { error } = await supabaseAdmin()
        .from("users")
        .update({
          attributes,
          // Only when an activation is being asked for. Written in the SAME
          // statement, so a crash between the two cannot leave a tier with no
          // record that anybody wanted a flip because of it.
          ...(bookablePendingSince ? { bookable_pending_since: bookablePendingSince } : {}),
        })
        .eq("id", userId);
      if (error) throw new Error(`Twilio attribute write failed: ${error.message}`);
    },
    recordAudit,
  };
}

export { TwilioReadError };
