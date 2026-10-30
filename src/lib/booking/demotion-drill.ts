/**
 * The daily drill that proves the reroute on ineligibility end to end (#3615).
 *
 * The automatic reroute is a fail safe detector's mirror image: it acts rarely, only when Twilio
 * narrows somebody, and a pipeline that silently stopped working would look exactly like a quiet
 * month (L557, #1394). Unit tests cannot close that, because a fake agrees with our assumptions
 * about the database, the reassign and the calendars by construction (L52). So once a day this
 * runs the REAL pieces, on the two smoke test advisors only:
 *
 *   1. book a test call on the DRILL bucket, keyed on the made up `drill` tier both carry;
 *   2. take that tier off whoever got the call, exactly as a Twilio narrowing would;
 *   3. run the real demotion decision (stamp, then sweep once past the debounce, on an injected
 *      clock so nothing waits), queue the real filtered sweep with what changed, and drain it;
 *   4. require the call to be with the other advisor, the change recorded on the sweep, and the
 *      move audited;
 *   5. move it back through the real move back, and require it back, audited, and pinned;
 *   6. ALWAYS cancel the call and restore the advisor's attributes, and report a cleanup that
 *      failed over any pass, because what it leaves behind is a demoted test advisor or a live
 *      test call.
 *
 * The hourly Twilio sync never evaluates a test advisor (`demotionEvalList`), so the drill drives
 * the same decision functions that sync runs rather than the sync itself.
 *
 * Every ending is its own reason (L11), and the command that calls this maps each to its own exit
 * code. Pure apart from the injected deps, so `scripts/test-demotion-drill.ts` drives every branch.
 */
import type { Attributes } from "@/lib/db/types";
import type { RerouteCandidate } from "@/lib/booking/reroute-eligibility";
import type { MoveBackOutcome } from "@/lib/booking/demotion-revert";
import {
  applyDemotionAction,
  DEMOTION_SWEEP_DEBOUNCE_MS,
  demotionChangeOf,
  planDemotionAction,
  readDemotionChange,
  type DemotionChange,
} from "@/lib/booking/demotion-plan";

import { DRILL_TIER } from "@/lib/embed/public-test-bucket";
export { DRILL_TIER };

/** Every way the drill can end. A runtime list so the command's exit table is checked against it. */
export const DRILL_REASONS = [
  "passed",
  "busy",
  // #4180: answered by the endpoint, never by the drill: the smoke canary held the test advisors.
  "test-advisors-held",
  "not-seeded",
  "no-free-slot",
  "booking-refused",
  "booked-outside-drill",
  "did-not-stamp",
  "did-not-sweep",
  "change-not-recorded",
  "sweep-queued-nothing",
  "did-not-move",
  "no-audit",
  "move-back-refused",
  "did-not-move-back",
  "not-pinned",
  "cleanup-failed",
  "errored",
] as const;
export type DrillReason = (typeof DRILL_REASONS)[number];

export interface DrillResult {
  reason: DrillReason;
  /** One plain sentence about what happened, with what failed when something did. */
  detail: string;
  /** On `cleanup-failed` only: what the drill had measured before its cleanup failed, so a broken
   *  pipeline measured on the same run is reported as measured rather than lost. */
  endedAs?: DrillReason;
}

export interface DrillAgent {
  id: string;
  email: string | null;
  attributes: Attributes | null;
}

/** Everything the drill touches, injected. `service.ts` wires the real ones. */
export interface DemotionDrillDeps {
  /** The bookable advisors the DRILL bucket's criteria reach. */
  loadDrillAgents(): Promise<DrillAgent[]>;
  /** The first time on the DRILL bucket that EVERY listed advisor is free at, or null when there is
   *  none. Free for one is not enough: the call can then land only on that one, and the sweep rightly
   *  finds nobody to move it to (2026-10-30). */
  findSlot(agentIds: string[]): Promise<string | null>;
  /** Book the DRILL bucket at `startIso`, or null when the booking path refused. */
  book(
    startIso: string,
    attendee: { name: string; email: string; externalId: string },
  ): Promise<{ bookingId: string; manageToken: string; assignedUserId: string | null } | null>;
  writeAttributes(userId: string, attributes: Attributes): Promise<void>;
  /** The advisor's upcoming calls, as the demotion decision reads them (pinned calls left out). */
  loadCandidates(userId: string): Promise<RerouteCandidate[]>;
  startSweep(input: {
    outUserId: string;
    markedAtIso: string;
    attributes: Attributes;
    change: DemotionChange | null;
  }): Promise<{ jobId: string; itemCount: number }>;
  /** Process every pending item of one sweep, through the real drain. */
  processJob(jobId: string): Promise<void>;
  loadBooking(bookingId: string): Promise<{ status: string; assigned_user_id: string | null } | null>;
  /** What the sweep recorded about one call, so a call that did not move says why. */
  sweepItem(jobId: string, bookingId: string): Promise<{ status: string; detail: string | null } | null>;
  /** The change recorded on the sweep, as stored. */
  loadJobChange(jobId: string): Promise<unknown>;
  /** The audit actions recorded about this booking. */
  auditActions(bookingId: string): Promise<string[]>;
  moveBack(bookingId: string, actorUserId: string): Promise<MoveBackOutcome>;
  pinnedFor(userId: string): Promise<Set<string>>;
  cancel(manageToken: string): Promise<void>;
  nowMs(): number;
  /** A per run value, so the test call's identity is unique per run (#3581). */
  nonce(): string;
}

const tiersOf = (a: Attributes | null | undefined): string[] => {
  const v = a?.debt_team;
  return Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)];
};

/** The first time every advisor is free at, in the first advisor's order; null when they share none. */
export function firstTimeAllFree(perAdvisor: string[][]): string | null {
  if (perAdvisor.length === 0) return null;
  const [first, ...rest] = perAdvisor;
  const others = rest.map((times) => new Set(times));
  return first.find((t) => others.every((set) => set.has(t))) ?? null;
}

class DrillFailure extends Error {
  readonly reason: DrillReason;
  constructor(reason: DrillReason, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

export async function runDemotionDrill(deps: DemotionDrillDeps): Promise<DrillResult> {
  const agents = await deps.loadDrillAgents();
  const drillAgents = agents.filter((a) => tiersOf(a.attributes).includes(DRILL_TIER));
  if (agents.length < 2 || drillAgents.length < 2) {
    return {
      reason: "not-seeded",
      detail: `The DRILL bucket reaches ${drillAgents.length} advisor(s) carrying the drill tier, and the drill needs two: run the smoke seed.`,
    };
  }
  const slot = await deps.findSlot(drillAgents.map((a) => a.id));
  if (!slot) {
    return { reason: "no-free-slot", detail: "The DRILL bucket offered no time when both drill advisors are free to book the test call on." };
  }

  let step = "book";
  let booked: { bookingId: string; manageToken: string } | null = null;
  let restore: { userId: string; attributes: Attributes } | null = null;
  let result: DrillResult;
  try {
    const nonce = deps.nonce();
    const made = await deps.book(slot, {
      name: "Reroute Drill",
      email: `smoketest+reroute-drill-${nonce}@trypennie.com`,
      externalId: `reroute-drill-${nonce}`,
    });
    if (!made) throw new DrillFailure("booking-refused", "The booking path refused the drill's test call.");
    booked = { bookingId: made.bookingId, manageToken: made.manageToken };
    const holder = drillAgents.find((a) => a.id === made.assignedUserId);
    if (!holder) {
      throw new DrillFailure(
        "booked-outside-drill",
        "The test call landed on an advisor outside the drill, so the drill bucket is not isolated and nobody was demoted.",
      );
    }
    const other = drillAgents.find((a) => a.id !== holder.id)!;

    // 2. The narrowing: the holder loses the drill tier, exactly as a Twilio narrowing would.
    step = "demote";
    const before: Attributes = structuredClone(holder.attributes ?? {});
    restore = { userId: holder.id, attributes: before };
    const after: Attributes = { ...before, debt_team: tiersOf(before).filter((t) => t !== DRILL_TIER) };
    await deps.writeAttributes(holder.id, after);

    // 3. The real decision: stamp now, then sweep once past the debounce.
    step = "decide";
    const nowIso = new Date(deps.nowMs()).toISOString();
    const candidates = await deps.loadCandidates(holder.id);
    const stampAction = planDemotionAction(before, after, candidates, nowIso);
    if (stampAction.kind !== "stamp") {
      throw new DrillFailure("did-not-stamp", `The demotion decision answered ${stampAction.kind} where it should have stamped the narrowing.`);
    }
    const stamped = applyDemotionAction(after, stampAction, nowIso)!.attributes;
    await deps.writeAttributes(holder.id, stamped);
    const laterIso = new Date(deps.nowMs() + DEMOTION_SWEEP_DEBOUNCE_MS + 60_000).toISOString();
    const sweepAction = planDemotionAction(stamped, stamped, candidates, laterIso);
    if (sweepAction.kind !== "sweep-overdue") {
      throw new DrillFailure("did-not-sweep", `Past the debounce the decision answered ${sweepAction.kind} where it should have swept.`);
    }
    const swept = applyDemotionAction(stamped, sweepAction, laterIso)!;
    const change = demotionChangeOf(swept.attributes);

    step = "sweep";
    const { jobId, itemCount } = await deps.startSweep({
      outUserId: holder.id,
      markedAtIso: sweepAction.markedAtIso,
      attributes: swept.attributes,
      change,
    });
    await deps.writeAttributes(holder.id, swept.attributes);
    if (itemCount < 1) throw new DrillFailure("sweep-queued-nothing", "The sweep queued no call to move, so the narrowing moved nobody.");

    // 4. The move, its record and its audit.
    step = "move";
    await deps.processJob(jobId);
    const moved = await deps.loadBooking(made.bookingId);
    if (moved?.assigned_user_id !== other.id) {
      const item = await deps.sweepItem(jobId, made.bookingId);
      // Only what the sweep recorded: the alert's headline already says the call did not move.
      throw new DrillFailure(
        "did-not-move",
        item
          ? `The sweep recorded the test call as ${item.status}${item.detail ? `: ${item.detail}` : "."}`
          : "The sweep ran and recorded nothing for the test call.",
      );
    }
    const recorded = readDemotionChange(await deps.loadJobChange(jobId));
    if (!recorded || !recorded.from.debtTeam.includes(DRILL_TIER) || recorded.to.debtTeam.includes(DRILL_TIER)) {
      throw new DrillFailure("change-not-recorded", "The sweep moved the call without recording what changed in Twilio.");
    }
    if (!(await deps.auditActions(made.bookingId)).includes("booking.demotion_reroute")) {
      throw new DrillFailure("no-audit", "The call moved and no audit row says why.");
    }

    // 5. The move back, and the pin that keeps it there.
    step = "move back";
    const back = await deps.moveBack(made.bookingId, holder.id);
    if (back.kind !== "moved-back") {
      throw new DrillFailure("move-back-refused", `The move back answered ${back.kind === "refused" ? back.reason : back.kind}.`);
    }
    const returned = await deps.loadBooking(made.bookingId);
    if (returned?.assigned_user_id !== holder.id) {
      throw new DrillFailure("did-not-move-back", "The move back answered done and the call is not with the original advisor.");
    }
    const pinned = (await deps.pinnedFor(holder.id)).has(made.bookingId);
    const stillCandidate = (await deps.loadCandidates(holder.id)).some((c) => c.bookingId === made.bookingId);
    if (!pinned || stillCandidate) {
      throw new DrillFailure("not-pinned", "The call went back and is not pinned, so the next sweep would move it again.");
    }
    result = { reason: "passed", detail: "A demotion moved the test call, recorded and audited it, and the move back held." };
  } catch (err) {
    result =
      err instanceof DrillFailure
        ? { reason: err.reason, detail: err.message }
        : { reason: "errored", detail: `The drill failed at the ${step} step: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 6. Always clean up, and say so over any pass when it could not.
  const cleanupErrors: string[] = [];
  if (booked) {
    await deps.cancel(booked.manageToken).catch((e: unknown) => cleanupErrors.push(`cancel: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (restore) {
    await deps
      .writeAttributes(restore.userId, restore.attributes)
      .catch((e: unknown) => cleanupErrors.push(`restore: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (cleanupErrors.length > 0) {
    return {
      reason: "cleanup-failed",
      detail: `The drill could not clean up after itself (${cleanupErrors.join("; ")}). Before that it had found: ${result.detail}`,
      endedAs: result.reason,
    };
  }
  return result;
}
