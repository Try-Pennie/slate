// A canary in cron standby runs no cron lane (#3095).
//
// During a gradual deploy two versions serve at once, and Cloudflare does not document
// which of them a scheduled event is handed to. So the canary is uploaded with
// SLATE_CRON_STANDBY=1 and its scheduled() handler stands down, which makes the answer
// independent of the platform: only the version already serving runs cron lanes, and
// code that has not passed its probe never does.
//
// Three things are pinned: the decision on every value the variable can hold, that the
// worker entry actually consults it BEFORE any lane is dispatched, and that the name the
// worker reads is the name the deploy sets (two spellings of one variable fail open).
//
// Run: node --experimental-strip-types scripts/test-cron-standby.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cronStandby } from "../worker/cron-standby.ts";
import { CRON_STANDBY_VAR, uploadArgs } from "./lib/gradual-deploy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

// --- the decision ----------------------------------------------------------------
eq(cronStandby(undefined).standby, false, "unset is a normal deployment: every lane runs");
eq(cronStandby("").standby, false, "empty is a normal deployment too (an unset var reaches the Worker as nothing)");
eq(cronStandby("0").standby, false, "an explicit 0 runs");
{
  const d = cronStandby("1");
  assert(d.standby && d.why === "set", "1 is standby, the value the gradual deploy uploads the canary with");
}
for (const garbled of ["true", "yes", " 1x", "2"]) {
  const d = cronStandby(garbled);
  // Only the canary upload ever sets this, so a value nobody can read most likely came
  // from one, and the safe side for a canary is to run nothing. Never the other way:
  // unproven code running a lane is the outcome this variable exists to prevent.
  assert(d.standby && d.why === "unreadable", `an unreadable value (${JSON.stringify(garbled)}) stands down rather than running lanes`);
}

// --- one name, both sides ---------------------------------------------------------
const entry = readFileSync(join(ROOT, "worker", "index.ts"), "utf8");
assert(
  entry.includes(`env.${CRON_STANDBY_VAR}`),
  `worker/index.ts reads env.${CRON_STANDBY_VAR}, the same name the gradual deploy sets`,
);
assert(
  uploadArgs("canary", "abc1234").join(" ").includes(`${CRON_STANDBY_VAR}:1`),
  "and the canary upload sets it to the value that means standby",
);

// --- consulted before any lane is dispatched ---------------------------------------
{
  const scheduled = entry.slice(entry.indexOf("async scheduled("));
  assert(scheduled.length > 0 && entry.includes("async scheduled("), "the scheduled handler is found");
  const standbyAt = scheduled.indexOf("cronStandby(");
  // #3354: every call into the app goes through the counted wrapper
  // (`worker/app-invocations.ts`), so a lane is dispatched through `app.fetch`.
  const dispatchAt = scheduled.indexOf("app.fetch(");
  const routesAt = scheduled.indexOf("routesForCron(");
  assert(standbyAt !== -1, "scheduled() consults cronStandby");
  assert(dispatchAt !== -1 && routesAt !== -1, "and the lane dispatch and route lookup it must come before are both found");
  assert(standbyAt < routesAt && standbyAt < dispatchAt, "and does so before resolving or dispatching any lane");
  // The standby branch must RETURN, or it only logs while the lanes run anyway.
  const branch = scheduled.slice(standbyAt, routesAt);
  assert(/\breturn;/.test(branch), "the standby branch returns before any lane runs");
}

finish();
