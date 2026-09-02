import type { User } from "@/lib/db/types";

/**
 * Rendering an agent's routing attributes (#1748). Both were local helpers on the
 * old single page /admin; the roster is its own route now, so they moved out
 * rather than being copied into it.
 *
 * `debt_team` is stored as an ARRAY on most agents and a bare string on a few, so
 * both shapes are read: treating it as one or the other drops every agent with the
 * shape that was not expected, and a roster filter that silently omits people is
 * worse than one that refuses.
 */
export function attrToText(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v === undefined || v === null) return "";
  return String(v);
}

export const teamsOf = (u: User): string[] => {
  const t = u.attributes?.debt_team;
  return Array.isArray(t) ? t.map(String) : t != null ? [String(t)] : [];
};
