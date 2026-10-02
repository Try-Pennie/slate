// The console is open to managers and admins in production (2026-10-02).
//
// #2102 held the console back until cutover. Dan opened it on 2026-10-02, the day
// of the Slate launch post, so managers can read Team hours and the rest of the
// console while the pilot runs. This pins that decision against the config AS
// WRANGLER RESOLVES IT, and drives the one predicate every console route and the
// header nav read (`consoleHiddenFor`) with the value production carries, so a
// revert of the var, or a gate that stopped reading it, fails here.
//
// It also proves the predicate still SPEAKS: with the flag off a manager is held
// out, so a `consoleHiddenFor` that always answered false could not pass (L1).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-console-open.ts
import { unstable_readConfig } from "wrangler";
import { consoleHiddenFor } from "../src/lib/env.ts";
import { assert, eq, finish } from "./lib/harness.ts";

type Resolved = { vars?: Record<string, unknown> };
const prod = unstable_readConfig({ config: "wrangler.jsonc" }) as unknown as Resolved;
const live = prod.vars?.AGENT_SCHEDULING_LIVE;

eq(live, "true", "production opens the console (AGENT_SCHEDULING_LIVE is \"true\")");

function hiddenWith(flag: string, role: string): boolean {
  const before = process.env.AGENT_SCHEDULING_LIVE;
  process.env.AGENT_SCHEDULING_LIVE = flag;
  try {
    return consoleHiddenFor(role);
  } finally {
    if (before === undefined) delete process.env.AGENT_SCHEDULING_LIVE;
    else process.env.AGENT_SCHEDULING_LIVE = before;
  }
}

const flag = typeof live === "string" ? live : "";
for (const role of ["manager", "admin", "super_admin"]) {
  assert(!hiddenWith(flag, role), `a ${role} reaches the console with production's value`);
}

// Positive control: the predicate still holds people out when the flag is off.
assert(hiddenWith("false", "manager"), "with the flag off a manager is held out");
assert(!hiddenWith("false", "super_admin"), "with the flag off a super admin still reaches it");

finish();
