import { filterSlotsFromNow, type BusinessHoursRules } from "@/lib/availability/compute";
import { explainEmptyWindow, type EmptyReason } from "@/lib/availability/empty-reason";
import { AGENT_LINK_COPY } from "@/lib/booking/booker-copy";
import type { AgentLinkJudgement } from "@/lib/agent-link/link";
import { AGENT_LINK_UNAVAILABLE_CODE } from "@/lib/agent-link/refusal-sentence";
import type { EventType } from "@/lib/db/types";

/**
 * The times an agent's own booking link offers (#2073), in the SAME response shape
 * `/api/availability` serves, so the booker and its shared picker draw them with
 * no second code path.
 *
 * Computed live for the one agent rather than read from the slot cache, because
 * the cache holds a POOL's times and a pool's times are exactly the wrong answer
 * here. It runs the same compute the cache is filled by (`getBucketSlots`, with
 * the pool narrowed to this agent), so the org's hours, the agent's hours, their
 * calendar and the daily cap are the same three gates and the same predicate.
 *
 * Every refusal is one body (`AGENT_LINK_UNAVAILABLE`) whatever the cause, so the
 * response cannot be used to learn whether a link was ever real.
 *
 * The compute after the link is judged is `namedAgentTimes`, which is ALSO what an
 * advisor link booking's move times are served from (#2827,
 * `src/lib/booking/reschedule-times.ts`): the times a lead can book with an advisor
 * and the times they can move that call to are one computation.
 */

/** The slice of an event type a lead may see, as `/api/availability` sends it. */
interface PublicEventType {
  name: string;
  description: string | null;
  durationMin: number;
}

/**
 * What computing ONE named agent's times needs (#2073, #2827). Shared by the
 * advisor link's read and by the read that offers an advisor link booking its
 * move times, so the two are one compute rather than two copies of it.
 */
export interface NamedAgentTimesDeps {
  horizonDays(): Promise<number>;
  /** That one agent's slots in the named bucket, or null when the bucket cannot
   *  be resolved. */
  slotsFor(
    bucketCode: string,
    agentUserId: string,
    fromIso: string,
    toIso: string,
  ): Promise<{ slots: string[]; eventType: EventType; orgName: string } | null>;
  /** For saying WHY there is nothing; null when it could not be read. */
  businessHours(): Promise<BusinessHoursRules | null>;
}

export interface AgentLinkAvailabilityDeps extends NamedAgentTimesDeps {
  /** The advisor link's name or old token, judged by the one resolver. */
  resolve(link: string): Promise<AgentLinkJudgement>;
  /** The refusal cause, for the log only. */
  logRefusal(why: string): void;
}

/** One named agent's times, in the shape `/api/availability` sends. */
export interface NamedAgentTimesBody {
  // The code is left EMPTY: which bucket a named booking is stored in is
  // internal, and the lead never chose it (rule #259, no routing internals in
  // the payload).
  bucket: { code: string };
  orgName: string;
  eventType: PublicEventType;
  slots: string[];
  emptyBecause: EmptyReason | null;
}

export type AgentLinkAvailabilityReply =
  | { status: 200; body: NamedAgentTimesBody }
  | { status: 400 | 404; body: { error: string; code: string } };

const DAY_MS = 86_400_000;

/** The one refusal, for every cause (see the header). */
function unavailableReply(): AgentLinkAvailabilityReply {
  return { status: 404, body: { error: AGENT_LINK_COPY.unavailable, code: AGENT_LINK_UNAVAILABLE_CODE } };
}

function readInstant(value: string | null): number | null | "unreadable" {
  if (value === null || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : "unreadable";
}

/**
 * The asked for window, read. `unreadable` when either bound is not a date, which
 * every caller answers with a 400 BEFORE reading anything else.
 */
export function readTimesWindow(query: {
  from: string | null;
  to: string | null;
}): { fromMs: number | null; toMs: number | null } | "unreadable" {
  const from = readInstant(query.from);
  const to = readInstant(query.to);
  if (from === "unreadable" || to === "unreadable") return "unreadable";
  return { fromMs: from, toMs: to };
}

/** The 400 for an unreadable window, one wording for both reads. */
export const UNREADABLE_WINDOW_BODY = { error: "The requested window could not be read.", code: "VALIDATION" };

/**
 * One named agent's offerable times in one bucket, bounded to the org's booking
 * horizon (#2073, #2827). Null when the bucket cannot be resolved, which each
 * caller answers with its own refusal.
 */
export async function namedAgentTimes(
  target: { bucketCode: string; agentUserId: string },
  window: { fromMs: number | null; toMs: number | null },
  nowMs: number,
  deps: NamedAgentTimesDeps,
): Promise<NamedAgentTimesBody | null> {
  // Bounded to the org's booking horizon however far the caller asks, because
  // this compute is live and per request. A day of slack covers the booker asking
  // from the start of the lead's day rather than from this instant.
  const horizonDays = await deps.horizonDays();
  const ceilingMs = nowMs + (horizonDays + 1) * DAY_MS;
  const fromMs = Math.max(window.fromMs ?? nowMs, nowMs);
  const toMs = Math.min(window.toMs ?? ceilingMs, ceilingMs);
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(Math.max(toMs, fromMs)).toISOString();

  const computed = await deps.slotsFor(target.bucketCode, target.agentUserId, fromIso, toIso);
  if (!computed) return null;

  const slots = filterSlotsFromNow(computed.slots, nowMs, computed.eventType.min_notice_min).filter(
    (s) => Date.parse(s) <= toMs,
  );

  // With nothing to offer, say whether the org is shut or the advisor is simply
  // full. One agent is the pool, so "nobody in the bucket" can never be the answer.
  let emptyBecause: EmptyReason | null = null;
  if (slots.length === 0) {
    const hours = await deps.businessHours();
    emptyBecause = explainEmptyWindow({ hours, horizonDays, nowMs, pooledAgents: 1 }).reason;
  }

  return {
    bucket: { code: "" },
    orgName: computed.orgName,
    eventType: {
      name: computed.eventType.name,
      description: computed.eventType.description,
      durationMin: computed.eventType.duration_min,
    },
    slots,
    emptyBecause,
  };
}

export async function agentLinkAvailability(
  link: string,
  query: { from: string | null; to: string | null },
  nowMs: number,
  deps: AgentLinkAvailabilityDeps,
): Promise<AgentLinkAvailabilityReply> {
  const window = readTimesWindow(query);
  if (window === "unreadable") return { status: 400, body: UNREADABLE_WINDOW_BODY };

  const judged = await deps.resolve(link);
  if (!judged.ok) {
    deps.logRefusal(judged.why);
    return unavailableReply();
  }

  const times = await namedAgentTimes(
    { bucketCode: judged.bucketCode, agentUserId: judged.agent.id },
    window,
    nowMs,
    deps,
  );
  if (!times) {
    // The bucket the judge chose vanished between the two reads. Nobody can be
    // booked through it right now, which is the same thing the lead is told.
    deps.logRefusal("bucket_unresolvable");
    return unavailableReply();
  }
  return { status: 200, body: times };
}
