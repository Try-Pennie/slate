/**
 * Pure resolution for syncing the agent->manager edge from Salesforce. Given
 * the SF agent records (each carrying its manager's email/name) and the set of
 * emails already in Slate, decides which manager users must be created and
 * which agent->manager links to apply. Side-effect-free so it's unit-testable
 * (`scripts/test-salesforce-manager-sync.ts`); the IO lives in `sync.ts`.
 */

export interface SfAgentRef {
  email: string;
  managerEmail: string | null;
  managerName: string | null;
}

export interface ManagerToCreate {
  email: string;
  name: string | null;
}

export interface ManagerLink {
  agentEmail: string;
  managerEmail: string;
}

export interface ManagerSyncPlan {
  /** Managers referenced by an agent but not yet a Slate user (nor a synced agent). */
  managersToCreate: ManagerToCreate[];
  /** agent->manager pairs to write (manager resolves to a Slate user). */
  links: ManagerLink[];
}

const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase();

/**
 * Resolves an informal "First Last" name (e.g. the Agent_Manager picklist value
 * "Mike Dugan") to an email by matching candidates on last name + first initial.
 * Returns the email ONLY when exactly one active user matches, so it never links
 * to the wrong person; ambiguous or no match returns null.
 */
export function matchByInitialLastName(
  name: string,
  candidates: { firstName: string; lastName: string; email: string }[],
): string | null {
  const toks = name.trim().split(/\s+/);
  if (toks.length < 2 || !toks[0]) return null;
  const initial = toks[0][0].toLowerCase();
  const last = toks[toks.length - 1].toLowerCase();
  const emails = [
    ...new Set(
      candidates
        .filter(
          (c) =>
            c.firstName[0]?.toLowerCase() === initial &&
            c.lastName.trim().toLowerCase() === last,
        )
        .map((c) => c.email.trim().toLowerCase()),
    ),
  ];
  return emails.length === 1 ? emails[0] : null;
}

/**
 * @param agents     SF agent records (emails already lowercased by the caller).
 * @param existingEmails Lowercased emails already present in Slate `users`.
 *
 * Every agent in `agents` will exist after the agent upsert, so a manager who
 * is also a synced agent never needs separate creation. Self-management is
 * dropped (an agent can't be their own manager).
 */
export function resolveManagerSync(
  agents: SfAgentRef[],
  existingEmails: Set<string>,
): ManagerSyncPlan {
  const agentEmails = new Set(agents.map((a) => norm(a.email)));
  const toCreate = new Map<string, ManagerToCreate>();
  const links: ManagerLink[] = [];

  for (const agent of agents) {
    const email = norm(agent.email);
    const managerEmail = norm(agent.managerEmail);
    if (!email || !managerEmail || managerEmail === email) continue;

    links.push({ agentEmail: email, managerEmail });
    if (!existingEmails.has(managerEmail) && !agentEmails.has(managerEmail)) {
      // Last writer wins on the display name; emails are the identity.
      toCreate.set(managerEmail, {
        email: managerEmail,
        name: agent.managerName?.trim() || null,
      });
    }
  }

  return { managersToCreate: [...toCreate.values()], links };
}
