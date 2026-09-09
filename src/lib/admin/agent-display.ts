import type { Attributes } from "@/lib/db/types";
import { BACKEND } from "@/lib/xbc";

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
 * the ladder reads the values as the rank they are.
 *
 * The agent detail page used to keep its own copy of that joiner, and the reason
 * recorded for it here was that the raw keys ARE the right thing there, because
 * the field was editable and wrote those keys straight back. That stopped being
 * true when #1874 made all three read only, and a reason left standing over code
 * whose premise has gone is read by everyone afterwards as a considered decision
 * (L346). The panel renders the ladder now (#2120), so both screens answer "what
 * does this agent cover" the same way and the copy is gone rather than argued
 * with.
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

/**
 * The label for a stored `backend_service` value (#2120).
 *
 * Same defect the debt teams had, in miniature: the panel printed `achieve`,
 * which is the machine spelling of a vocabulary `BACKEND` has paired with a
 * label all along, and the 60 buckets keyed on it are already named with the
 * labels. One vocabulary, two spellings, and this panel picked the unreadable
 * one.
 *
 * A value OUTSIDE the vocabulary comes back as stored rather than being dropped
 * or prettified, which is the rule the ladder's off-ladder chips already follow
 * (L113): `backend_service` is written by the hourly Salesforce sync and nothing
 * constrains it to the two keys, so a value nobody planned for must read as the
 * data question it is instead of vanishing off the screen that exists to show
 * it.
 *
 * Absent is `null`, and that is NOT the same as an unknown value: a blank is not
 * a backend, and rendering one as a chip would report a data problem that is
 * really an empty string.
 */
const BACKEND_LABEL_BY_KEY = new Map<string, string>(
  Object.values(BACKEND)
    .filter((b): b is { key: string; label: string } => b.key !== null)
    .map((b) => [b.key, b.label]),
);

export function backendServiceLabel(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (raw === "") return null;
  return BACKEND_LABEL_BY_KEY.get(raw.toLowerCase()) ?? raw;
}

/**
 * An agent's backend services, labelled, whichever shape they are stored in.
 *
 * Reads an array as well as a bare string for the same reason `teamsOf` does: the
 * sync writes both shapes and treating it as one drops every agent carrying the
 * other. EVERY value is labelled, not just the first: an agent covering two
 * backends who was shown one would be under reported on the panel that exists to
 * say what they cover.
 */
export function backendServiceOf(u: { attributes?: Attributes | null }): string | null {
  const b = u.attributes?.backend_service;
  const raw = Array.isArray(b) ? b.map(String) : b != null ? [String(b)] : [];
  const labels = raw
    .map(backendServiceLabel)
    .filter((l): l is string => l !== null);
  return labels.length === 0 ? null : labels.join(", ");
}
