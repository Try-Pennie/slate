// The Salesforce roster sync alert links the page its remedy is on (2026-10-29).
//
// The page that fired that day told the reader to "run Sync from the admin page",
// naming no page, and Sync runs the same job, so pressing it while the job itself
// was refusing could only fail again (L111). The alert now links Agent roster, where the
// sync button is, and says the press is for after the cause is gone.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-agent-sync-alert-link.ts
import { assert, finish } from "./lib/harness.ts";
import { agentSyncFailureAlert } from "../src/lib/monitor/cron-alert-copy.ts";

const text = agentSyncFailureAlert("SF token failed: 522 error code: 522", "https://slate.example");

assert(
  text.includes("<https://slate.example/admin/agents|Agent roster>"),
  "links the Agent roster page, where the sync button is, as a Slack link",
);
assert(text.includes("Sync from Salesforce and Twilio"), "names the button by the label it carries on the page");
assert(!/the admin page/.test(text), "no longer sends the reader to an unnamed admin page");
assert(text.includes("SF token failed: 522 error code: 522"), "still carries why it failed");
assert(!/^Slate/.test(text), "an alert never opens with the word Slate");

finish();
