/**
 * Offboarding active-user predicate (#265). A user is active iff they have not
 * been deactivated. Use this to hide deactivated people from rendered lists
 * (roster, pickers) while keeping the full set available for name resolution on
 * historical records — never drop a deactivated user from the data, only from
 * the lists where picking or counting them would be wrong.
 */
export function isActive(user: { deactivated_at: string | null }): boolean {
  return user.deactivated_at == null;
}

export function activeUsers<T extends { deactivated_at: string | null }>(
  users: T[],
): T[] {
  return users.filter(isActive);
}
