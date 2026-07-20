import type { Attributes } from "@/lib/db/types";

// alert_state row key for the throttle; lives with the feature so the cron and
// the settings screen refer to the one constant.
export const AGENTS_WITHOUT_ROUTING_KEY = "agents_without_routing";

/**
 * Routing-attribute coverage (#226). A bucket routes an agent only when the
 * agent's attributes satisfy the bucket's criteria (`matchesCriteria`) or the
 * agent is an active manual `bucket_members` row. An agent with NO routing
 * attributes at all matches no criteria, so unless someone added them manually
 * they are never routed a booking: an invisible gap, most dangerous at cutover.
 * This monitor whispers the list so nobody silently falls out of routing. There
 * is no self-heal (unlike schedule-coverage #838): attributes cannot be invented,
 * a human must set them or add the agent to a bucket.
 */

export type UnroutableAgent = { id: string; name: string | null; email: string | null };

/** An agent carries at least one usable routing attribute. Empty string, empty
 *  array, and null/undefined values do not count (they match no criteria). */
export function hasRoutingAttributes(attributes: Attributes | null | undefined): boolean {
  if (!attributes) return false;
  return Object.values(attributes).some((v) => {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "string") return v.trim().length > 0;
    return true; // a present number or boolean is a set attribute
  });
}

/**
 * From the bookable agents and the set of user ids with an active manual bucket
 * membership, the agents that can never be routed: no routing attributes AND no
 * manual membership. Pure, so the classification is unit-tested directly.
 */
export function findUnroutableAgents(
  agents: { id: string; name: string | null; email: string | null; attributes: Attributes | null }[],
  manualMemberIds: Set<string>,
): UnroutableAgent[] {
  return agents
    .filter((a) => !manualMemberIds.has(a.id) && !hasRoutingAttributes(a.attributes))
    .map(({ id, name, email }) => ({ id, name, email }));
}

// Match the other monitor notices' list cap so a broad gap stays one readable
// Slack post, not a wall of names.
const NAME_CAP = 8;

function agentLine(a: UnroutableAgent): string {
  const name = a.name?.trim() || a.email || a.id;
  return a.email && a.email !== name ? `${name} (${a.email})` : name;
}

/**
 * The Slack info notice for bookable agents that match no bucket and have no
 * manual membership, or "" when there are none. Worded as a staffing gap, not a
 * malfunction: unlike the schedule gap there is no auto-fill, so a human must
 * set attributes or add the agent to a bucket.
 */
export function formatAttributeGapNotice(agents: UnroutableAgent[]): string {
  if (!agents.length) return "";
  const lines = agents.slice(0, NAME_CAP).map(agentLine);
  const more = agents.length > NAME_CAP ? ` (and ${agents.length - NAME_CAP} more)` : "";
  return (
    `Slate (info): ${agents.length} bookable agent(s) have no routing attributes and no ` +
    `manual bucket membership, so they match no bucket and are never routed a booking. ` +
    `Set their attributes (admin > agents) or add them to a bucket.${more}\n` +
    lines.join("\n")
  );
}

/**
 * The monitor-cron step (#226): find bookable agents that can never be routed and
 * whisper the list. The notify failure is swallowed (fail-soft): a flaky Slack
 * must never fail the monitor tick. Repeat suppression is the persistent
 * `alert_state` cooldown inside `notify`, not this call.
 */
export async function runAttributeCoverageCheck(deps: {
  loadUnroutableAgents: () => Promise<UnroutableAgent[]>;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<{ unroutable: number }> {
  const agents = await deps.loadUnroutableAgents();
  if (agents.length) {
    await deps
      .notify(AGENTS_WITHOUT_ROUTING_KEY, deps.cooldownMs, formatAttributeGapNotice(agents))
      .catch(() => {});
  }
  deps.log?.(`monitor attribute-coverage: ${agents.length} unroutable agent(s)`);
  return { unroutable: agents.length };
}
