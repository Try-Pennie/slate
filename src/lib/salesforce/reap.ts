/**
 * Offboarding reap selection (#265), pure. Given the reapable candidate rows
 * (agents/managers who never logged in) and the set of emails Salesforce reports
 * INACTIVE (lowercased), return the ids to DEACTIVATE.
 *
 * Unlike the old hard-delete reaper, there is no "skip users who manage OOO
 * history" carve-out: deactivation sets `deactivated_at` and keeps the row, so
 * manager/approver attribution on historical OOO requests stays intact. The
 * row is preserved, so a boomerang rehire can be reactivated (a flip back to
 * null) with no data loss.
 */
export function reapableUserIds(
  rows: { id: string; email: string }[],
  inactiveEmails: Set<string>,
): string[] {
  return rows
    .filter((u) => inactiveEmails.has(u.email.toLowerCase()))
    .map((u) => u.id);
}
