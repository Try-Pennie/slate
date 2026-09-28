import { AGENT_LINK_COPY } from "@/lib/booking/booker-copy";

/** The refusal code every agent link read and confirm answers with (#2073). */
export const AGENT_LINK_UNAVAILABLE_CODE = "AGENT_LINK_UNAVAILABLE";

/**
 * The sentence for a times read refused because the agent's link books nobody,
 * or null for any other failure (#2073). Reached when a link is replaced or the
 * advisor stops taking bookings while the page sits open; a fresh page load says
 * the same thing before any picker is drawn. A retry cannot fix it, so a surface
 * showing it offers none, which is how the shared picker treats every sentence
 * carried here.
 */
export function agentLinkRefusalSentence(payload: unknown): string | null {
  const code = (payload as { code?: unknown } | null)?.code;
  return code === AGENT_LINK_UNAVAILABLE_CODE ? AGENT_LINK_COPY.unavailable : null;
}
