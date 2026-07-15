// Under the load test (SLATE_LOADTEST=true), webhook delivery must record a
// synthetic success and SKIP the external POST, so a 200-agent soak exercises
// the delivery-row insert + the (endpoint,event,dedupe_key) unique index without
// hammering a real subscriber. Off the flag, it must behave exactly as before
// (return null -> caller does the real send). Pure over process.env, no DB.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-webhook-loadtest.ts
import { loadtestDeliveryResult } from "../src/lib/webhooks/emit.ts";
import { assert, finish } from "./lib/harness.ts";

const prior = process.env.SLATE_LOADTEST;

process.env.SLATE_LOADTEST = "true";
const stub = loadtestDeliveryResult();
assert(stub !== null, "load-test mode returns a synthetic delivery result");
assert(stub?.ok === true, "the synthetic delivery is marked a success (no failed-retry churn)");

delete process.env.SLATE_LOADTEST;
assert(loadtestDeliveryResult() === null, "off the flag it opts out so the real external POST runs");

process.env.SLATE_LOADTEST = "false";
assert(loadtestDeliveryResult() === null, "an explicit false is not load-test mode");

if (prior === undefined) delete process.env.SLATE_LOADTEST;
else process.env.SLATE_LOADTEST = prior;

finish();
