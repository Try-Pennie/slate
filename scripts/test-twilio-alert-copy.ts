// Run: node --experimental-strip-types scripts/test-twilio-alert-copy.ts
//
// What the twilio_sync_failures page SAYS (#2097), read as the person on the phone
// reads it rather than as a substring assertion.
//
// The reason this is its own file rather than a line in the sync's test: the sync
// decides WHETHER to page and the copy decides whether the page is worth waking up
// for, and those rot separately. The five refusals each carry their own cause and
// their own instruction; what the alert has to add is the CONSEQUENCE, which is the
// part a reader cannot infer and the only reason the page is urgent at all.
import { twilioSyncFailureAlert, twilioSyncRecovery } from "@/lib/monitor/cron-alert-copy";
import { alertEntry } from "@/lib/notify/alert-catalog";
import { assert, eq, finish } from "./lib/harness.ts";

const NOT_CONFIGURED =
  "Twilio is not configured on this deployment: TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET and TWILIO_WORKSPACE_SID must all be set (see DEPLOY.md).";
const REFUSED = "Twilio refused the credentials (401). The API key has to be TaskRouter scoped.";

{
  const text = twilioSyncFailureAlert(NOT_CONFIGURED);
  // The consequence, which is the whole reason this pages: while it is failing,
  // nobody is being taken out of the pool for the tag.
  assert(/bookable pool/i.test(text), "the page says what is NOT happening while it fails");
  assert(/Redistribute/.test(text), "and names the tag, which is the vocabulary the manager who set it uses");
  // The half that still worked, so nobody spends the morning on Salesforce.
  assert(/Salesforce still synced/.test(text), "and says the Salesforce half was fine, so the reader looks in the right place");
  assert(text.includes(NOT_CONFIGURED), "the cause is carried through verbatim, so the instruction reaches the reader");
}

{
  // Distinct causes, distinct messages (L11): one wording answering for both would
  // send somebody to the deploy runbook over a Twilio outage, or the reverse.
  assert(
    twilioSyncFailureAlert(NOT_CONFIGURED) !== twilioSyncFailureAlert(REFUSED),
    "two different causes do not produce the same page",
  );
  assert(/TaskRouter/.test(twilioSyncFailureAlert(REFUSED)), "a refused key says the key has to be TaskRouter scoped");
  assert(/DEPLOY.md/.test(twilioSyncFailureAlert(NOT_CONFIGURED)), "an unconfigured deployment is sent to the runbook");
}

{
  const text = twilioSyncRecovery();
  // A recovery that only said "it works again" would leave the reader wondering
  // whether the agents tagged during the outage were ever dealt with.
  assert(/bookable pool/i.test(text), "the all-clear says the backlog was caught up, not merely that it works");
  assert(/No action is needed/.test(text), "and closes the loop, because that is the only thing the reader has to decide");
}

{
  // A condition, so it MUST have a recovery, and the recovery must not read as a
  // fresh page (#1151). The catalog is what the coverage guard reads, so this is the
  // one assertion that ties the copy to the classification.
  eq(alertEntry("twilio_sync_failures")?.kind, "condition", "it is a condition, so it is allowed to clear and must");
}

{
  // No message may OPEN with Slate: in Slack every one of these arrives under
  // Slate's own app name and icon, so the label repeats the header and pushes the
  // one fact worth having further along a line read on a phone.
  for (const [name, text] of [
    ["the page", twilioSyncFailureAlert(REFUSED)],
    ["the all-clear", twilioSyncRecovery()],
  ] as const) {
    assert(!/^Slate\b/.test(text), `${name} does not open by repeating Slate's own name`);
    assert(!/undefined|NaN|\[object/.test(text), `${name} renders no leaked value`);
  }
}

finish();
