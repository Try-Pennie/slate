// Tests for the pure agent->manager resolution used by the Salesforce sync.
// Run: node --experimental-strip-types scripts/test-salesforce-manager-sync.ts
import {
  resolveManagerSync,
  type SfAgentRef,
} from "../src/lib/salesforce/manager-sync.ts";
import { assert, finish } from "./lib/harness.ts";

const agent = (
  email: string,
  managerEmail: string | null,
  managerName: string | null = null,
): SfAgentRef => ({ email, managerEmail, managerName });

// --- manager is neither a Slate user nor a synced agent -> create + link ---
{
  const plan = resolveManagerSync(
    [agent("a@x.com", "mgr@x.com", "Mona Manager")],
    new Set(["a@x.com"]),
  );
  assert(plan.managersToCreate.length === 1, "absent manager queued for creation");
  assert(
    plan.managersToCreate[0].email === "mgr@x.com" &&
      plan.managersToCreate[0].name === "Mona Manager",
    "created manager carries email + name",
  );
  assert(
    plan.links.length === 1 &&
      plan.links[0].agentEmail === "a@x.com" &&
      plan.links[0].managerEmail === "mgr@x.com",
    "link recorded",
  );
}

// --- manager already a Slate user -> link only, no creation ---
{
  const plan = resolveManagerSync(
    [agent("a@x.com", "mgr@x.com")],
    new Set(["a@x.com", "mgr@x.com"]),
  );
  assert(plan.managersToCreate.length === 0, "existing manager not recreated");
  assert(plan.links.length === 1, "link still recorded");
}

// --- manager is also a synced agent -> no creation (agent insert covers) ---
{
  const plan = resolveManagerSync(
    [agent("a@x.com", "lead@x.com"), agent("lead@x.com", "boss@x.com")],
    new Set([]),
  );
  const createdEmails = plan.managersToCreate.map((m) => m.email).sort();
  assert(
    JSON.stringify(createdEmails) === JSON.stringify(["boss@x.com"]),
    "only the manager who isn't a synced agent is created",
  );
  assert(plan.links.length === 2, "both agent->manager links recorded");
}

// --- agent with no manager -> nothing ---
{
  const plan = resolveManagerSync([agent("a@x.com", null)], new Set(["a@x.com"]));
  assert(
    plan.managersToCreate.length === 0 && plan.links.length === 0,
    "no manager means no link or creation",
  );
}

// --- self-management is dropped ---
{
  const plan = resolveManagerSync(
    [agent("a@x.com", "A@X.com")],
    new Set(["a@x.com"]),
  );
  assert(
    plan.managersToCreate.length === 0 && plan.links.length === 0,
    "an agent can't be their own manager (case-insensitive)",
  );
}

// --- duplicate manager across agents -> created once, linked per agent ---
{
  const plan = resolveManagerSync(
    [agent("a@x.com", "mgr@x.com"), agent("b@x.com", "MGR@x.com", "Mona")],
    new Set([]),
  );
  assert(plan.managersToCreate.length === 1, "shared manager created once");
  assert(plan.links.length === 2, "each agent gets a link");
  assert(
    plan.links.every((l) => l.managerEmail === "mgr@x.com"),
    "manager email normalized to lowercase across agents",
  );
}

// --- blank/whitespace manager email -> skipped ---
{
  const plan = resolveManagerSync(
    [agent("a@x.com", "   "), agent("b@x.com", "")],
    new Set(["a@x.com", "b@x.com"]),
  );
  assert(
    plan.managersToCreate.length === 0 && plan.links.length === 0,
    "blank manager email is ignored",
  );
}

// --- #1474: the sync must CONVERGE, so it also has to say what to CLEAR ---
//
// The sync only ever added a link, so a link written once (or written wrongly)
// survived forever and Slate's roster silently diverged from the source it
// mirrors (L41). Two live rows proved it, one of them pointing at its own row.
//
// The whole difficulty is that "Salesforce says this person has no manager" and
// "Salesforce named someone we could not resolve" both arrive as a null email, and
// only the first is grounds for clearing. Getting that wrong wipes a correct link
// every time a picklist name is ambiguous (L11: a value that could not be read is
// never scored as an answer).
{
  // Salesforce positively names NO manager: a clear.
  const plan = resolveManagerSync([agent("a@x.com", null, null)], new Set(["a@x.com"]));
  assert(plan.links.length === 0, "no manager named: nothing to link");
  assert(
    plan.clears.length === 1 && plan.clears[0] === "a@x.com",
    "an agent Salesforce says has NO manager is cleared",
  );
}
{
  // Salesforce NAMES a manager the resolver could not turn into an email. We could
  // not tell, so the existing link stands: neither a link nor a clear.
  const plan = resolveManagerSync(
    [agent("a@x.com", null, "Ambiguous Person")],
    new Set(["a@x.com"]),
  );
  assert(plan.links.length === 0, "an unresolvable manager name links nothing");
  assert(
    plan.clears.length === 0,
    "an unresolvable manager name does NOT clear: could-not-resolve is not no-manager",
  );
  assert(
    plan.unresolved.length === 1 && plan.unresolved[0] === "Ambiguous Person",
    "the unresolvable name is reported, so a silent no-op is visible",
  );
}
{
  // Salesforce names the agent as their own manager. Skipping the write was
  // already right; leaving an existing self link in place is not (#1474).
  const plan = resolveManagerSync([agent("a@x.com", "a@x.com", "A Self")], new Set(["a@x.com"]));
  assert(plan.links.length === 0, "a self link is never written");
  assert(
    plan.clears.length === 1 && plan.clears[0] === "a@x.com",
    "a self link is CLEARED, not merely skipped",
  );
}
{
  // A resolved manager is a link, never also a clear: the two lists must not
  // disagree, because the writer applies both.
  const plan = resolveManagerSync(
    [agent("a@x.com", "mgr@x.com", "Mona Manager"), agent("b@x.com", null, null)],
    new Set(["a@x.com", "b@x.com", "mgr@x.com"]),
  );
  assert(plan.links.length === 1 && plan.links[0].agentEmail === "a@x.com", "the resolved agent is linked");
  assert(plan.clears.length === 1 && plan.clears[0] === "b@x.com", "the unmanaged agent is cleared");
  const linked = new Set(plan.links.map((l) => l.agentEmail));
  assert(
    plan.clears.every((e) => !linked.has(e)),
    "no agent appears in both links and clears",
  );
}
{
  // An agent with no email at all is not a subject: it can be neither linked nor
  // cleared, and clearing "" would be a write against nobody.
  const plan = resolveManagerSync([agent("", null, null)], new Set());
  assert(plan.links.length === 0 && plan.clears.length === 0, "an agent with no email is skipped entirely");
}

// The informal-name matcher moved to manager-link.ts in #1653, and its cases
// moved with it to scripts/test-salesforce-manager-link.ts, where an ambiguous
// name is now asserted to be REPORTED rather than to merely return null.

finish();
