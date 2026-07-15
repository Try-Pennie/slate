// Tests for the pure agent->manager resolution used by the Salesforce sync.
// Run: node --experimental-strip-types scripts/test-salesforce-manager-sync.ts
import {
  matchByInitialLastName,
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

// --- matchByInitialLastName: informal Agent_Manager picklist names ---
const cands = [
  { firstName: "Michael", lastName: "Dugan", email: "mdugan@x.com" },
  { firstName: "Matt", lastName: "Rasmussen", email: "mrasmussen@x.com" },
];
assert(
  matchByInitialLastName("Mike Dugan", cands) === "mdugan@x.com",
  "informal 'Mike Dugan' resolves to Michael Dugan by initial+last",
);
assert(
  matchByInitialLastName("Matthew Rasmussen", cands) === "mrasmussen@x.com",
  "'Matthew Rasmussen' resolves to Matt Rasmussen",
);
assert(
  matchByInitialLastName("Jane Doe", cands) === null,
  "no match returns null",
);
assert(
  matchByInitialLastName("Cher", cands) === null,
  "single-token name returns null",
);
// Two people with the same initial + last name: never guess.
assert(
  matchByInitialLastName("Mike Dugan", [
    ...cands,
    { firstName: "Mary", lastName: "Dugan", email: "marydugan@x.com" },
  ]) === null,
  "ambiguous initial+last (Michael & Mary Dugan) does NOT resolve",
);

finish();
