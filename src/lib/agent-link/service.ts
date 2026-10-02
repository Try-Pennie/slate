import { getBucketSlots, namedAgentResolver } from "@/lib/availability/service";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadBusinessHoursCached } from "@/lib/booking/business-hours-load";
import { resolveAgentLink } from "@/lib/agent-link/store";
import {
  agentLinkAvailability,
  type AgentLinkAvailabilityReply,
  type NamedAgentTimesDeps,
} from "@/lib/agent-link/availability";
import { log } from "@/lib/log";

/**
 * The real compute for ONE named agent's times (#2073), shared by the advisor
 * link's read and by the move times of an advisor link booking (#2827), so both
 * run `getBucketSlots` narrowed through `namedAgentResolver` and nothing else.
 * `tag` names the caller in the log.
 */
export function namedAgentTimesLiveDeps(tag: string): NamedAgentTimesDeps {
  return {
    horizonDays: loadBookingHorizonDays,
    slotsFor: async (bucketCode, agentUserId, fromIso, toIso) => {
      const r = await getBucketSlots(bucketCode, fromIso, toIso, namedAgentResolver(agentUserId));
      return r ? { slots: r.slots, eventType: r.eventType, orgName: r.orgName } : null;
    },
    // Only asked to say WHY an empty week is empty, so a failed read leaves the
    // reason unknown (the booker's vaguer honest copy) rather than failing the
    // response that carries the times.
    businessHours: () =>
      loadBusinessHoursCached().catch((err) => {
        log.warn(tag, { msg: "could not read the org's week to explain an empty window" }, err);
        return null;
      }),
  };
}

/**
 * The real wiring for an agent link's times (#2073). The decisions are in
 * `availability.ts`, which the node suite drives through fakes.
 */
export function agentLinkAvailabilityLive(
  link: string,
  query: { from: string | null; to: string | null },
  nowMs: number,
): Promise<AgentLinkAvailabilityReply> {
  return agentLinkAvailability(link, query, nowMs, {
    ...namedAgentTimesLiveDeps("agent-link"),
    resolve: resolveAgentLink,
    // The cause, never the name or token: either in the log is a working link in it.
    logRefusal: (why) => log.info("agent-link", { msg: "link books nobody", why }),
  });
}
