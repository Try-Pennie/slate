import type { Attributes } from "@/lib/db/types";

/**
 * Reading an agent's routing attributes (#1748). A local helper on the old single
 * page /admin; the roster is its own route now, so it moved out rather than being
 * copied into it.
 *
 * `debt_team` is stored as an ARRAY on most agents and a bare string on a few, so
 * both shapes are read: treating it as one or the other drops every agent with the
 * shape that was not expected, and a roster filter that silently omits people is
 * worse than one that refuses.
 *
 * `attrToText`, which joined the values into a comma list, is gone with the column
 * that rendered it (#1796). Its last reader printed database keys at a person, and
 * the ladder reads the values as the rank they are. The agent detail page keeps
 * its own copy, deliberately: there the raw keys ARE the right thing, because the
 * field is editable and writes those keys straight back.
 */
/**
 * An agent's debt teams, whichever shape they are stored in.
 *
 * Typed on the ATTRIBUTES rather than on `User`, because every caller holds a
 * narrower row than a full user and each was reaching it through an
 * `as unknown as User` cast. A cast is not a type check: it would have silently
 * accepted a row that had no attributes at all.
 */
export const teamsOf = (u: { attributes?: Attributes | null }): string[] => {
  const t = u.attributes?.debt_team;
  return Array.isArray(t) ? t.map(String) : t != null ? [String(t)] : [];
};
