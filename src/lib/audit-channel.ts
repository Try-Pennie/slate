/**
 * The channels a write can be recorded as having come through (#3542, plan decision
 * 11: "every write lands in the product's existing audit log under the person's
 * name, tagged with the channel").
 *
 * Only MACHINE and MCP channels are named. A row with no `details.channel` was
 * written by Slate's own screens or lanes, which is every row written before this
 * existed; naming those `web` or `system` positively is a separate change, and
 * until it lands an absent channel means "not recorded", never a claim about
 * which surface wrote it. The channel goes in `details` rather than a column
 * because migration 0160 already hashes `details` into the chain, so the chain
 * function is unchanged and an edited channel breaks the walk like any other edit.
 *
 * Its own module with no imports, so the trail's display (`audit-display.ts`) can
 * key its per channel wording on this list without reaching the writer's database
 * client, and `tsc` refuses a channel added here without that wording.
 */
export const AUDIT_CHANNELS = ["marcia"] as const;
export type AuditChannel = (typeof AUDIT_CHANNELS)[number];

/** Whether a stored `details.channel` names a declared channel. */
export function isAuditChannel(value: unknown): value is AuditChannel {
  return typeof value === "string" && (AUDIT_CHANNELS as readonly string[]).includes(value);
}
