// #3094: the rollback workflow's Slack alerter, mirroring
// scripts/test-notify-parity-failure.ts.
//
// It runs only when a rollback did not end cleanly, which is during an incident. So it
// must quote the ending the rollback wrote, say plainly when there is none, and go
// visibly red rather than pretending anybody was warned when Slack refuses.
//
// Run: node --experimental-strip-types scripts/test-notify-rollback.ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRollbackAlert, readRollbackSummary, run } from "./notify-rollback.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  assertAlerterFailsLoud,
  assertHouseStyle,
  FAIL_LOUD_CHECKS,
  HOUSE_STYLE_CHECKS,
} from "./lib/alerter-contract.ts";

const RUN = "https://github.com/Try-Pennie/slate/actions/runs/9";

{
  const text = buildRollbackAlert({ exit: 33, message: "Rolled back to X, and it FAILED its probe." }, { runUrl: RUN, actor: "dan" });
  assert(text.includes("exit 33") && text.includes("FAILED its probe"), "it quotes the ending the rollback wrote");
  assert(text.includes("dan"), "and says who started it");
  assert(text.includes(RUN), "and links the run");
  assert(!/^Slate/.test(text), "it does not open with the word Slate");
  assertHouseStyle(assert, text, "");
}
{
  const text = buildRollbackAlert(null, { runUrl: "", actor: "" });
  assert(/may or may not have rolled back/.test(text), "with no ending it says the state is unknown, rather than guessing");
  assert(/Actions tab/.test(text) && !/\n\s*$/.test(text), "and with no link it says where to look");
}

// --- reading the summary file ------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "rollback-summary-"));
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify({ exit: 32, message: "failed" }));
  eq(JSON.stringify(readRollbackSummary(good)), JSON.stringify({ exit: 32, message: "failed" }), "a written ending is read");
  const bad = join(dir, "bad.json");
  writeFileSync(bad, '{"exit":"32"}');
  eq(readRollbackSummary(bad), null, "an ending with no numeric exit is no ending");
  eq(readRollbackSummary(join(dir, "missing.json")), null, "an absent file is no ending");
  eq(readRollbackSummary(""), null, "an unset path is no ending");
  rmSync(dir, { recursive: true, force: true });
}

// --- the fail-loud contract --------------------------------------------------------
{
  const made = await assertAlerterFailsLoud(assert, {
    configured: (post) => run(post, { RUN_URL: RUN, SLACK_ALERTS_CHANNEL: "C123" }),
    unconfigured: (post) => run(post, { RUN_URL: RUN }),
    channel: "C123",
  });
  eq(made, FAIL_LOUD_CHECKS, "the shared contract made every check it claims to");
}

eq(HOUSE_STYLE_CHECKS, 3, "the house style contract is the size its caller assumes");

finish();
