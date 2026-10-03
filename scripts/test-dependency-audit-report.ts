// The daily dependency audit's message, for every combination of outcomes (#3092,
// #3093). Hand written step outcomes, a fake poster, no network.
//
// Run: node --experimental-strip-types scripts/test-dependency-audit-report.ts
import { decideAuditAlert } from "./lib/dependency-audit-report.ts";
import { run } from "./notify-dependency-audit.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { assertHouseStyle, HOUSE_STYLE_CHECKS } from "./lib/alerter-contract.ts";

const URL = "https://github.com/Try-Pennie/slate/actions/runs/1";
const d = (prod: string, full: string) => decideAuditAlert({ prod, full, runUrl: URL });

// --- the quiet direction -----------------------------------------------------------
eq(d("success", "success").alert, null, "both audits passing says nothing");

// --- each finding, on its own words (L11) ------------------------------------------
{
  const prod = d("failure", "success").alert ?? "";
  assert(/production dependency/.test(prod), "a production finding says it is in what ships");
  assert(!/toolchain/.test(prod), "and does not claim the toolchain");
  assert(prod.includes(URL), "and links the run");
  eq(assertHouseStyle(assert, prod, "production message"), HOUSE_STYLE_CHECKS, "house style held");

  const full = d("success", "failure").alert ?? "";
  assert(/toolchain/.test(full) && /deploy token/.test(full), "a full tree finding names the build and deploy chain");
  assert(!/production dependency/.test(full), "and does not claim a production dependency");

  const both = d("failure", "failure").alert ?? "";
  assert(/production dependency/.test(both) && /toolchain/.test(both), "both findings are both said");
}

// --- an audit that never finished is never a pass, and never a finding (L98) -------
{
  const none = d("", "");
  assert(none.alert !== null, "an audit that never ran is not silence");
  assert(/could not finish the production audit or the full tree audit/.test(none.alert ?? ""), "it names both");
  assert(!/found/.test(none.alert ?? ""), "and claims nothing was found");
  assert(/Re-run/.test(none.alert ?? ""), "and says the remedy is a re-run");

  const partial = d("success", "cancelled").alert ?? "";
  assert(/could not finish the full tree audit/.test(partial), "one unfinished audit is named on its own");
  assert(!/production audit/.test(partial), "without the one that passed");

  const mixed = d("failure", "skipped").alert ?? "";
  assert(/production dependency/.test(mixed) && /full tree audit/.test(mixed), "a finding and an unrun audit are both said");
  assert(/bump or replace/.test(mixed), "and the remedy is the finding's");

  assert(d("bogus", "success").alert !== null, "an outcome this does not know is treated as unfinished, not as a pass");
}

// --- the alerter: posts only when there is something to say -----------------------
{
  const posts: { text: string; channel?: string }[] = [];
  const post = async (m: { text: string; channel?: string }) => {
    posts.push(m);
    return { ok: true };
  };
  const quiet = await run(post, { PROD_AUDIT: "success", FULL_AUDIT: "success", RUN_URL: URL, SLACK_ALERTS_CHANNEL: "C1" });
  eq(quiet.code, 0, "a clean day exits 0");
  eq(posts.length, 0, "and posts nothing");

  const loud = await run(post, { PROD_AUDIT: "failure", FULL_AUDIT: "success", RUN_URL: URL, SLACK_ALERTS_CHANNEL: "C1" });
  eq(loud.code, 1, "a finding keeps the run red even once it is posted");
  eq(posts.length, 1, "and posts exactly once");
  eq(posts[0]?.channel, "C1", "to the configured channel");

  const unsent = await run(async () => ({ ok: false, error: "slack-not-configured" }), {
    PROD_AUDIT: "failure",
    FULL_AUDIT: "success",
    RUN_URL: URL,
  });
  eq(unsent.code, 1, "an undelivered alert is red too");
  assert(/slack-not-configured/.test(unsent.reason), "and says why it was not delivered");
}

finish();
