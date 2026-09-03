import { matchesSearchQuery, normalizeSearchQuery } from "@/lib/search-query";

/** Minimal agent shape the manager reassign picker needs (#546). */
export interface ReassignAgent {
  id: string;
  name: string | null;
  email: string;
  /** In the bookable round-robin pool. Out-of-pool agents are still selectable
   *  (coverage/escalation) but sort below and are flagged in the UI. */
  bookable: boolean;
}

/**
 * Filter + order the agents shown in the manager reassign picker (#546):
 * exclude the booking's current agent, match the query against name OR email
 * (case-insensitive, and honouring a trailing space as a word boundary, #1791),
 * and sort in-pool (bookable) agents to the top, then by
 * name/email. Pure so it's unit-tested and the UI can't drift.
 */
export function rankReassignAgents(
  agents: ReassignAgent[],
  query: string,
  currentAgentId?: string | null,
): ReassignAgent[] {
  // One shared rule for every search box (#1791): a trailing space is the word
  // boundary and is kept, a leading one is noise and is dropped.
  const q = normalizeSearchQuery(query);
  const label = (a: ReassignAgent) => (a.name ?? a.email).toLowerCase();
  return agents
    .filter((a) => a.id !== currentAgentId)
    .filter((a) => matchesSearchQuery(q, a.name, a.email))
    .sort((a, b) => {
      if (a.bookable !== b.bookable) return a.bookable ? -1 : 1;
      return label(a).localeCompare(label(b));
    });
}
