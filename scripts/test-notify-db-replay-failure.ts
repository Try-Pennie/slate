// #3099: the nightly real database run's Slack alerter, mirroring
// scripts/test-notify-parity-failure.ts.
//
// The thing worth pinning is the fail-loud contract: post exactly once to the
// configured channel, and go visibly red rather than pretending anybody was warned
// when Slack refuses or was never configured.
//
// Run: node --experimental-strip-types scripts/test-notify-db-replay-failure.ts
import { buildDbReplayFailureMessage, readContextFromEnv, run } from "./notify-db-replay-failure.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  assertAlerterFailsLoud,
  assertHouseStyle,
  FAIL_LOUD_CHECKS,
  HOUSE_STYLE_CHECKS,
} from "./lib/alerter-contract.ts";

const RUN = "https://github.com/Try-Pennie/slate/actions/runs/9";

// --- the copy --------------------------------------------------------------------
{
  const text = buildDbReplayFailureMessage({ runUrl: RUN });
  assert(/nightly real database run failed/.test(text), "it says the nightly run failed");
  assert(/from empty/.test(text), "and what that leaves unproved");
  assert(/Docker was not available/.test(text), "it names a missing Docker as one of the ways it fails, since that is a failure here and not a skip");
  assert(text.includes(RUN), "and links the run, which is where the cause is named");
  assert(!/^Slate/.test(text), "it does not open with the word Slate: Slack already says who sent it");
  assert(!/undefined|NaN|\[object/.test(text), "nothing leaks into the copy");
  assertHouseStyle(assert, text, "");
}

// An unset RUN_URL is an empty string, so the message must not end on a blank line
// where a reader expects a link (#1494).
{
  const text = buildDbReplayFailureMessage(readContextFromEnv({}));
  assert(/Actions tab/.test(text), "with no run link it says where to look instead");
  assert(!/\n\s*$/.test(text), "and does not trail off into an empty line");
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
