/**
 * The Regal call ignore list on /admin/alerts (#2090): who the picker offers, how a
 * person is named, and what an add must satisfy before it is written.
 *
 * The list is a set of Slate users, so it is a PICKER over the roster and never a
 * text box (L611): a typed address offers every typo as an entry that silently
 * suppresses nobody. Each person is shown by name.
 *
 * Only people the detector could ever report are offered: role `agent`, a real
 * advisor (not a test user, not the placeholder, #4201). Everybody else is already exempt in code (`REGAL_ROLE_EXEMPT`), and listing
 * them would let somebody write a suppression that does nothing while reading as a
 * decision. A deactivated agent IS offered, because a departed employee whose Regal
 * seat is being shut off is a real reason to suppress, and is labelled as such.
 *
 * Pure, so scripts/test-regal-call-ignores.ts drives it.
 */
import { REGAL_ROLE_EXEMPT } from "@/lib/monitor/regal-calls";
import { isRealAdvisor } from "@/lib/advisors/real-advisor";
import type { Role } from "@/lib/db/types";

export interface IgnoreRosterUser {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  is_test: boolean;
  is_placeholder: boolean;
  deactivated_at: string | null;
}

export interface IgnoreRow {
  user_id: string;
  reason: string;
  added_by: string | null;
  added_at: string;
}

/** How long a reason may be. A sentence, not an essay, and a bound on the row. */
export const IGNORE_REASON_MAX = 300;

/** A person's display name: their name, or the address when the roster has none. */
export function personLabel(u: Pick<IgnoreRosterUser, "name" | "email">): string {
  return u.name?.trim() || u.email;
}

/**
 * The picker's options, alphabetical by name. Two people with the same name carry
 * their address so they can be told apart, and nobody else does: the address on
 * every row would say one fact twice (L605).
 */
export function ignorePickerOptions(
  users: IgnoreRosterUser[],
  ignores: Pick<IgnoreRow, "user_id">[],
): { value: string; label: string }[] {
  const listed = new Set(ignores.map((i) => i.user_id));
  const eligible = users.filter((u) => REGAL_ROLE_EXEMPT[u.role] === false && isRealAdvisor(u) && !listed.has(u.id));
  const nameCount = new Map<string, number>();
  for (const u of eligible) {
    const k = personLabel(u).toLowerCase();
    nameCount.set(k, (nameCount.get(k) ?? 0) + 1);
  }
  return eligible
    .map((u) => {
      const base = personLabel(u);
      const named = (nameCount.get(base.toLowerCase()) ?? 0) > 1 ? `${base} (${u.email})` : base;
      return { value: u.id, label: u.deactivated_at ? `${named}, deactivated` : named };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The listed people, alphabetical by name, each with who added them. */
export function ignoreListRows(
  ignores: IgnoreRow[],
  users: Pick<IgnoreRosterUser, "id" | "name" | "email">[],
): { userId: string; person: string; email: string | null; reason: string; addedBy: string; addedAt: string }[] {
  const byId = new Map(users.map((u) => [u.id, u]));
  return ignores
    .map((i) => {
      const u = byId.get(i.user_id);
      const by = i.added_by ? byId.get(i.added_by) : undefined;
      return {
        userId: i.user_id,
        // A row whose person is gone cascades away with them, so an unknown id here
        // is a roster read that came back short; it is shown as itself rather than
        // hidden, so it can still be seen and removed.
        person: u ? personLabel(u) : `Unknown user ${i.user_id}`,
        email: u ? u.email : null,
        reason: i.reason,
        addedBy: by ? personLabel(by) : "someone no longer in Slate",
        addedAt: i.added_at,
      };
    })
    .sort((a, b) => a.person.localeCompare(b.person));
}

/**
 * Validate an add. Returns the row to write or the sentence to show. The picker
 * only offers eligible people, and this re-checks every one of those rules on the
 * server, because a posted form is not bound by the options it was drawn with.
 */
export function parseIgnoreAdd(
  raw: { userId: string; reason: string },
  target: IgnoreRosterUser | null,
): { ok: true; row: { user_id: string; reason: string } } | { ok: false; error: string } {
  const reason = raw.reason.trim();
  if (!raw.userId.trim()) return { ok: false, error: "Pick the person to add." };
  if (!target) return { ok: false, error: "That person is not in Slate." };
  if (REGAL_ROLE_EXEMPT[target.role] !== false) {
    return { ok: false, error: `${personLabel(target)} is not an agent, so their calls are never reported.` };
  }
  if (target.is_test) {
    return { ok: false, error: `${personLabel(target)} is a test user, so their calls are never reported.` };
  }
  if (target.is_placeholder) {
    return { ok: false, error: `${personLabel(target)} is the placeholder advisor, so their calls are never reported.` };
  }
  if (!reason) return { ok: false, error: "Say why their calls should not be reported." };
  if (reason.length > IGNORE_REASON_MAX) {
    return { ok: false, error: `Keep the reason under ${IGNORE_REASON_MAX} characters.` };
  }
  return { ok: true, row: { user_id: target.id, reason } };
}
