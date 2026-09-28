import { getBucketSlots, namedAgentResolver } from "@/lib/availability/service";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadBusinessHoursCached } from "@/lib/booking/business-hours-load";
import { resolveAgentLink } from "@/lib/agent-link/store";
import { agentLinkAvailability, type AgentLinkAvailabilityReply } from "@/lib/agent-link/availability";
import { log } from "@/lib/log";

/**
 * The real wiring for an agent link's times (#2073). The decisions are in
 * `availability.ts`, which the node suite drives through fakes.
 */
export function agentLinkAvailabilityLive(
  token: string,
  query: { from: string | null; to: string | null },
  nowMs: number,
): Promise<AgentLinkAvailabilityReply> {
  return agentLinkAvailability(token, query, nowMs, {
    resolve: resolveAgentLink,
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
        log.warn("agent-link", { msg: "could not read the org's week to explain an empty window" }, err);
        return null;
      }),
    // The cause, never the token: a token in the log is a working link in the log.
    logRefusal: (why) => log.info("agent-link", { msg: "link books nobody", why }),
  });
}
