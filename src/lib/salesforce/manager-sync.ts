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
  /**
   * Agent emails whose `manager_id` must be set back to NULL, because Salesforce
   * positively says they have no manager, or names them as their own (#1474).
   *
   * This is what makes the sync CONVERGE instead of accumulate. It is deliberately
   * narrow: an agent only reaches this list when Salesforce named nothing at all.
   * An agent whose manager NAME was given but could not be resolved to an email is
   * in `unresolved` instead, and is left exactly as it is, because "we could not
   * work out who this is" must never be written down as "this person has no
   * manager" (L11).
   *
   * No email appears in both `links` and `clears`.
   */
  clears: string[];
  /**
   * Manager names Salesforce gave that could not be resolved to a Slate user.
   *
   * Reported rather than dropped, because this is the case where the sync
   * deliberately does nothing, and a silent no-op here is indistinguishable from
   * an agent who genuinely has no manager. The caller logs it.
   */
  unresolved: string[];
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
  const clears: string[] = [];
  const unresolved: string[] = [];

  for (const agent of agents) {
    const email = norm(agent.email);
    // An agent with no email is not a subject at all: it can be neither linked nor
    // cleared, and a clear keyed on "" would be a write against nobody.
    if (!email) continue;

    const managerEmail = norm(agent.managerEmail);
    const managerName = (agent.managerName ?? "").trim();

    if (!managerEmail) {
      // The distinction the whole convergence rests on (#1474). Salesforce giving
      // NO name is a fact about the person: clear. Salesforce giving a name we
      // could not resolve is a fact about our matching: leave the row alone and
      // say so, because writing null here would silently delete a correct link
      // every time a picklist name went ambiguous.
      if (managerName) unresolved.push(managerName);
      else clears.push(email);
      continue;
    }

    if (managerEmail === email) {
      // Salesforce names the agent as their own manager. Skipping the write was
      // always right; leaving an EXISTING self link in place is not, and one was
      // live in production.
      clears.push(email);
      continue;
    }

    links.push({ agentEmail: email, managerEmail });
    if (!existingEmails.has(managerEmail) && !agentEmails.has(managerEmail)) {
      // Last writer wins on the display name; emails are the identity.
      toCreate.set(managerEmail, {
        email: managerEmail,
        name: agent.managerName?.trim() || null,
      });
    }
  }

  return { managersToCreate: [...toCreate.values()], links, clears, unresolved };
}
