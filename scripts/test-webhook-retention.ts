// #1073: lock the webhook-payload retention window. The cron blanks attendee PII
// on deliveries older than this cutoff, so a wrong default silently over- or
// under-retains contact data. Provisional 90 days, pending Pennie legal (#1029).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-webhook-retention.ts
import {
  WEBHOOK_PAYLOAD_RETENTION_DAYS,
  webhookPayloadCutoffIso,
} from "../src/lib/webhooks/retention.ts";
import { assert, eq, finish } from "./lib/harness.ts";

eq(WEBHOOK_PAYLOAD_RETENTION_DAYS, 90, "retention window is 90 days");

const now = "2026-07-23T12:00:00.000Z";
// 90 days before 2026-07-23 is 2026-04-24.
eq(
  webhookPayloadCutoffIso(now).slice(0, 10),
  "2026-04-24",
  "cutoff is 90 days before now",
);

// An explicit override is honored (so #1029/legal can retune without code change).
assert(
  webhookPayloadCutoffIso(now, 30).slice(0, 10) === "2026-06-23",
  "an explicit day count overrides the default",
);

finish();
