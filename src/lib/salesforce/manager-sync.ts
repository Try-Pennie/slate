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
