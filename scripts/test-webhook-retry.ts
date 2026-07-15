// Sanity test for the webhook retry/backoff policy.
// Run: node --experimental-strip-types scripts/test-webhook-retry.ts
import {
  WEBHOOK_MAX_ATTEMPTS,
  webhookBackoffMs,
  isDeadLettered,
  isDueForRetry,
} from "../src/lib/webhooks/retry.ts";
import { assert, finish } from "./lib/harness.ts";

const M = 60_000;
assert(webhookBackoffMs(0) === 1 * M, "0 attempts -> 1 min");
assert(webhookBackoffMs(1) === 2 * M, "1 attempt -> 2 min");
assert(webhookBackoffMs(3) === 8 * M, "3 attempts -> 8 min");
assert(webhookBackoffMs(10) === 30 * M, "backoff caps at 30 min");

const now = 1_000_000_000;
assert(isDueForRetry(1, now - 2 * M, now), "due once the backoff window elapses");
assert(!isDueForRetry(1, now - 1 * M, now), "not due inside the backoff window");
assert(isDueForRetry(0, now - 1 * M, now), "a stuck-pending row (0 attempts) is due after 1 min");
assert(
  !isDueForRetry(WEBHOOK_MAX_ATTEMPTS, now - 60 * M, now),
  "exhausted attempts are never due (dead-lettered)",
);

// --- isDeadLettered (batch replay targeting, #33) ---
assert(
  isDeadLettered("failed", WEBHOOK_MAX_ATTEMPTS),
  "failed with attempts exhausted is dead-lettered",
);
assert(
  isDeadLettered("failed", WEBHOOK_MAX_ATTEMPTS + 1),
  "manual resends past the cap stay dead-lettered if they fail again",
);
assert(
  !isDeadLettered("failed", WEBHOOK_MAX_ATTEMPTS - 1),
  "failed under the cap is NOT dead-lettered (cron still owns it)",
);
assert(!isDeadLettered("pending", WEBHOOK_MAX_ATTEMPTS), "pending is never dead-lettered");
assert(!isDeadLettered("success", WEBHOOK_MAX_ATTEMPTS), "success is never dead-lettered");

finish();
