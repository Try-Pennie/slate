// #2031: the daily parity sweep's Slack alerter, mirroring
// scripts/test-notify-smoke-failure.ts.
//
// It speaks only about the sweep FAILING to run or report, never about the drift
// itself (Slate reports that, so the alert can have a cooldown and an all clear).
// So the thing worth pinning is the fail-loud contract: post exactly once to the
// configured channel, and go visibly red rather than pretending anybody was warned
// when Slack refuses or was never configured. A silent no-op here would leave the
// only signal to be a stale heartbeat thirty hours later.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/test-notify-parity-failure.ts
import { buildParityFailureMessage, readContextFromEnv, run } from "./notify-parity-failure.ts";
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
  const text = buildParityFailureMessage({ runUrl: RUN });
  assert(/did not complete/.test(text), "it says the comparison did not finish");
  assert(/cal\.com/.test(text), "and names what it compares against");
  assert(text.includes(RUN), "and links the run, which is where the cause is named");
  assert(!/^Slate/.test(text), "it does not open with the word Slate: Slack already says who sent it");
  assert(!/undefined|NaN|\[object/.test(text), "nothing leaks into the copy");
  assertHouseStyle(assert, text, "");
}

// An unset RUN_URL is an empty string, never undefined, so the message must not end
// on a blank line where a reader expects a link (#1494: an unset repo variable
// interpolates to "").
{
  const text = buildParityFailureMessage(readContextFromEnv({}));
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
