// Relative value imports so this module runs under `node --experimental-strip-types`
// in tests (a "@/" value import is not erased).
import { parseStampMs } from "../date/stamp.ts";
import { canHoldManagerOfRecord } from "./core.ts";
import type { OooEventMismatch } from "./alert-copy.ts";
import type { Span } from "./event-coverage.ts";
import type { Role } from "@/lib/db/types";

/**
 * Who hears about an approved time off whose calendar event no longer matches it,
 * and when (#3372). Dan's decisions, 2026-10-06:
 *
 *  1. the agent is told first, on Slack, the way they are told time off was approved;
 *  2. if it is not fixed, their manager is told;
 *  3. the alerts channel hears only if neither acts.
 *
 * Every step is decided here, pure, from what the monitor lane MEASURED this tick and
 * from the record of who has already been told. The plan only ever acts on
 * `mismatches`, which hold the judge's `not-blocking` and `uncovered` verdicts and
 * nothing else: a window the lane could not compare (unmeasured, unreadable, out of
 * the pool) is neither escalated nor cleared, because a false message to an agent is
 * worse than none (#3655).
 *
 * Who was told, and when, is kept in `alert_state` (key to timestamp, deny-all RLS,
 * already the store for alert cooldowns and firing markers), one row per person told
 * per request. The rows are bounded by the approved time off still ahead, and every
 * one is removed when its request agrees again, leaves the approved set or its agent
 * departs, so the table does not grow with them.
 */

export const OOO_MISMATCH_NOTICE_PREFIX = "ooo_mismatch_told:";
const NO_MANAGER = "none";
const UNREACHABLE = "unreachable";

/**
 * What the manager step found. `none`: no manager of record who can act on time off.
 * `unreachable`: there is one, and the message could not be delivered. Both send the
 * alerts channel the page without a second wait, and neither gets an all-clear,
 * because nobody read the first message. Kept apart because they send a reader to
 * fix two different things (L11): the roster, or Slack.
 */
export type ManagerOutcome =
  | { kind: "told"; managerId: string }
  | { kind: "none" }
  | { kind: "unreachable" };

/** The record that the agent was told about one request. */
export function agentNoticeKey(agentId: string, requestId: string): string {
  return `${OOO_MISMATCH_NOTICE_PREFIX}agent:${agentId}:${requestId}`;
}

/**
 * The record that the manager step ran for one request. It names the manager who was
 * told, so the all-clear goes to that person, or records why nobody was.
 */
export function managerNoticeKey(agentId: string, requestId: string, outcome: ManagerOutcome): string {
  const token = outcome.kind === "told" ? outcome.managerId : outcome.kind === "none" ? NO_MANAGER : UNREACHABLE;
  return `${OOO_MISMATCH_NOTICE_PREFIX}manager:${agentId}:${requestId}:${token}`;
}

export type NoticeRecord =
  | { role: "agent"; agentId: string; requestId: string; toldAtMs: number | null; key: string }
  | {
      role: "manager";
      agentId: string;
      requestId: string;
      outcome: ManagerOutcome;
      toldAtMs: number | null;
      key: string;
    };

/**
 * One `alert_state` row read back as a record, or null when the key is not one of
 * these. An unreadable stamp is null, which the plan reads as the wait being over:
 * escalating early is the loud direction, waiting for ever is the silent one.
 */
export function parseNoticeRow(row: { key: string; last_sent_at: string }): NoticeRecord | null {
  if (!row.key.startsWith(OOO_MISMATCH_NOTICE_PREFIX)) return null;
  const parts = row.key.slice(OOO_MISMATCH_NOTICE_PREFIX.length).split(":");
  const toldAtMs = parseStampMs(row.last_sent_at);
  if (parts[0] === "agent" && parts.length === 3 && parts[1] && parts[2]) {
    return { role: "agent", agentId: parts[1], requestId: parts[2], toldAtMs, key: row.key };
  }
  if (parts[0] === "manager" && parts.length === 4 && parts[1] && parts[2] && parts[3]) {
    return {
      role: "manager",
      agentId: parts[1],
      requestId: parts[2],
      outcome:
        parts[3] === NO_MANAGER
          ? { kind: "none" }
          : parts[3] === UNREACHABLE
            ? { kind: "unreachable" }
            : { kind: "told", managerId: parts[3] },
      toldAtMs,
      key: row.key,
    };
  }
  return null;
}

/** A gap opening within a day is "starting tomorrow": there is no time left to wait on one person. */
export const URGENT_LEAD_MS = 24 * 60 * 60_000;
/** Inside three days there is still a working day to fix it, but not a weekend. */
export const SOON_LEAD_MS = 3 * 24 * 60 * 60_000;

export type EscalationPace = "urgent" | "soon" | "relaxed";

/**
 * How long each person gets before the next one is told, by pace. The pace is worked
 * out again on every tick from the gap's start, so a mismatch found a fortnight out
 * speeds up by itself as the day approaches.
 */
export const PACES: Record<EscalationPace, { agentGraceMs: number; managerGraceMs: number }> = {
  // Starting tomorrow, or a call already booked in the gap: an hour each, so the
  // alerts channel hears within about two hours.
  urgent: { agentGraceMs: 60 * 60_000, managerGraceMs: 60 * 60_000 },
  // One to three days out: half a working day each.
  soon: { agentGraceMs: 4 * 60 * 60_000, managerGraceMs: 4 * 60 * 60_000 },
  // Further out: two days for the agent, who may be off or busy, and one for the
  // manager, so even a mismatch found a week out has climbed the ladder before it
  // turns soon.
  relaxed: { agentGraceMs: 48 * 60 * 60_000, managerGraceMs: 24 * 60 * 60_000 },
};

export function escalationPace(gapStartMs: number, nowMs: number, bookedInGap: boolean): EscalationPace {
  if (bookedInGap) return "urgent";
  const lead = gapStartMs - nowMs;
  if (lead < URGENT_LEAD_MS) return "urgent";
  if (lead < SOON_LEAD_MS) return "soon";
  return "relaxed";
}

/**
 * The hours a finding leaves open, as measured: the judge's open spans for an event
 * that covers part of the window, and what is still ahead of a window the calendar
 * blocks none of, up to where the lane could check. Hours already gone, and the tail
 * too far ahead to check (#3655), are never part of it.
 */
export function gapSpans(f: OooEventMismatch, nowMs: number): Span[] {
  if (f.coverage.kind === "uncovered") return f.coverage.spans;
  const start = parseStampMs(f.startsAt);
  const end = parseStampMs(f.endsAt);
  if (start === null || end === null) return [];
  const from = Math.max(start, nowMs);
  const until = f.coverage.unmeasured?.startMs ?? end;
  return until > from ? [{ startMs: from, endMs: until }] : [];
}

/** Whether a booked call overlaps the gap. An unreadable call is not counted. */
export function bookedInsideGap(gap: Span[], calls: { startsAt: string; endsAt: string }[]): boolean {
  for (const c of calls) {
    const s = parseStampMs(c.startsAt);
    const e = parseStampMs(c.endsAt);
    if (s === null || e === null) continue;
    if (gap.some((g) => s < g.endMs && e > g.startMs)) return true;
  }
  return false;
}

export interface PersonForEscalation {
  id: string;
  name: string | null;
  email: string | null;
  role: Role;
  deactivatedAt: string | null;
}

/** A person as the escalation reads them: the agent, with who their manager is, or the manager. */
export interface EscalationPerson extends PersonForEscalation {
  /** The agent's manager of record (`users.manager_id`), which Salesforce owns. */
  managerId: string | null;
}

/**
 * The manager to tell, or null when there is nobody who can act. The same floor the
 * time off notifications use (`canHoldManagerOfRecord`, #1475), so a manager of record
 * who cannot approve a changed request is not asked to get one changed.
 */
export function managerToTell(
  agent: { id: string; managerId: string | null },
  manager: PersonForEscalation | null,
): PersonForEscalation | null {
  if (!agent.managerId || !manager || manager.id !== agent.managerId) return null;
  if (manager.id === agent.id) return null;
  if (manager.deactivatedAt !== null || !manager.email) return null;
  return canHoldManagerOfRecord(manager.role) ? manager : null;
}

/** One measured mismatch, for an agent whose streak has held. */
export interface MeasuredMismatch {
  agentId: string;
  requestId: string;
  finding: OooEventMismatch;
  /** When the first open hour begins (`gapSpans`). */
  gapStartMs: number;
  bookedInGap: boolean;
}

export interface EscalationPlan {
  /** Nobody has been told: the agent hears now. */
  tellAgent: MeasuredMismatch[];
  /** The agent was told and their wait is over. */
  tellManager: MeasuredMismatch[];
  /** The manager step ran and its wait is over, or nobody could be told. */
  pageDan: MeasuredMismatch[];
  /** Requests that no longer need anybody, with the records of who to tell so. */
  clear: { agentId: string; requestId: string; why: "agreed" | "left-approved"; records: NoticeRecord[] }[];
  /** Records of a departed agent, dropped without a message. */
  forget: NoticeRecord[];
}

const waited = (toldAtMs: number | null, graceMs: number, nowMs: number) =>
  toldAtMs === null || nowMs - toldAtMs >= graceMs;

export function planEscalation(input: {
  nowMs: number;
  /** Measured `not-blocking` or `uncovered` verdicts, for agents whose streak held. */
  mismatches: MeasuredMismatch[];
  /** Requests whose every hour still ahead was compared this tick and agrees. */
  agreed: Set<string>;
  /** Every request in this tick's approved set, whatever its verdict. */
  approved: Set<string>;
  departedAgents: Set<string>;
  records: NoticeRecord[];
}): EscalationPlan {
  const byRequest = new Map<string, NoticeRecord[]>();
  for (const r of input.records) {
    const list = byRequest.get(r.requestId) ?? [];
    list.push(r);
    byRequest.set(r.requestId, list);
  }
  const plan: EscalationPlan = { tellAgent: [], tellManager: [], pageDan: [], clear: [], forget: [] };

  for (const m of input.mismatches) {
    if (input.departedAgents.has(m.agentId)) continue;
    const recs = byRequest.get(m.requestId) ?? [];
    const agent = recs.find((r) => r.role === "agent");
    const manager = recs.find((r) => r.role === "manager");
    const pace = PACES[escalationPace(m.gapStartMs, input.nowMs, m.bookedInGap)];
    if (!agent && !manager) plan.tellAgent.push(m);
    else if (!manager) {
      if (waited(agent!.toldAtMs, pace.agentGraceMs, input.nowMs)) plan.tellManager.push(m);
    } else if (
      (manager.role === "manager" && manager.outcome.kind !== "told") ||
      waited(manager.toldAtMs, pace.managerGraceMs, input.nowMs)
    ) {
      plan.pageDan.push(m);
    }
  }

  for (const [requestId, recs] of byRequest) {
    const agentId = recs[0]!.agentId;
    if (input.departedAgents.has(agentId)) {
      plan.forget.push(...recs);
      continue;
    }
    if (!input.approved.has(requestId)) {
      plan.clear.push({ agentId, requestId, why: "left-approved", records: recs });
    } else if (input.agreed.has(requestId)) {
      plan.clear.push({ agentId, requestId, why: "agreed", records: recs });
    }
    // Otherwise the request is still mismatched, or this tick could not measure it:
    // either way its records stand.
  }
  return plan;
}
