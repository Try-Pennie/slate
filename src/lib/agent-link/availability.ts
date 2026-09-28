import { filterSlotsFromNow, type BusinessHoursRules } from "@/lib/availability/compute";
import { explainEmptyWindow, type EmptyReason } from "@/lib/availability/empty-reason";
import { AGENT_LINK_COPY } from "@/lib/booking/booker-copy";
import type { AgentLinkJudgement } from "@/lib/agent-link/link";
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
 * response cannot be used to learn whether a token was ever real.
 */

/** The slice of an event type a lead may see, as `/api/availability` sends it. */
interface PublicEventType {
  name: string;
  description: string | null;
  durationMin: number;
}

export interface AgentLinkAvailabilityDeps {
  resolve(token: string): Promise<AgentLinkJudgement>;
  horizonDays(): Promise<number>;
  /** That one agent's slots in the bucket the link books into, or null when the
   *  bucket cannot be resolved. */
  slotsFor(
    bucketCode: string,
    agentUserId: string,
    fromIso: string,
    toIso: string,
  ): Promise<{ slots: string[]; eventType: EventType; orgName: string } | null>;
  /** For saying WHY there is nothing; null when it could not be read. */
  businessHours(): Promise<BusinessHoursRules | null>;
  /** The refusal cause, for the log only. */
  logRefusal(why: string): void;
}

export type AgentLinkAvailabilityReply =
  | {
      status: 200;
      body: {
        // The shape `/api/availability` sends, with the code left EMPTY: which
        // bucket a named booking is stored in is internal, and the lead never
        // chose it (rule #259, no routing internals in the payload).
        bucket: { code: string };
        orgName: string;
        eventType: PublicEventType;
        slots: string[];
        emptyBecause: EmptyReason | null;
      };
    }
  | { status: 400 | 404; body: { error: string; code: string } };

const DAY_MS = 86_400_000;

function readInstant(value: string | null): number | null | "unreadable" {
  if (value === null || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : "unreadable";
}

export async function agentLinkAvailability(
  token: string,
  query: { from: string | null; to: string | null },
  nowMs: number,
  deps: AgentLinkAvailabilityDeps,
): Promise<AgentLinkAvailabilityReply> {
  const from = readInstant(query.from);
  const to = readInstant(query.to);
  if (from === "unreadable" || to === "unreadable") {
    return { status: 400, body: { error: "The requested window could not be read.", code: "VALIDATION" } };
  }

  const link = await deps.resolve(token);
  if (!link.ok) {
    deps.logRefusal(link.why);
    return { status: 404, body: { error: AGENT_LINK_COPY.unavailable, code: "AGENT_LINK_UNAVAILABLE" } };
  }

  // Bounded to the org's booking horizon however far the caller asks, because
  // this compute is live and per request. A day of slack covers the booker asking
  // from the start of the lead's day rather than from this instant.
  const horizonDays = await deps.horizonDays();
  const ceilingMs = nowMs + (horizonDays + 1) * DAY_MS;
  const fromMs = Math.max(from ?? nowMs, nowMs);
  const toMs = Math.min(to ?? ceilingMs, ceilingMs);
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(Math.max(toMs, fromMs)).toISOString();

  const computed = await deps.slotsFor(link.bucketCode, link.agent.id, fromIso, toIso);
  if (!computed) {
    // The bucket the judge chose vanished between the two reads. Nobody can be
    // booked through it right now, which is the same thing the lead is told.
    deps.logRefusal("bucket_unresolvable");
    return { status: 404, body: { error: AGENT_LINK_COPY.unavailable, code: "AGENT_LINK_UNAVAILABLE" } };
  }

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
    status: 200,
    body: {
      bucket: { code: "" },
      orgName: computed.orgName,
      eventType: {
        name: computed.eventType.name,
        description: computed.eventType.description,
        durationMin: computed.eventType.duration_min,
      },
      slots,
      emptyBecause,
    },
  };
}
