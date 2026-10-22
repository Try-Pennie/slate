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
import {
  twilioSyncFailureAlert,
  twilioSyncRecovery,
  twilioWriteFailureAlert,
  twilioWriteFailureRecovery,
  twilioOrphanedMarkAlert,
  twilioOrphanedMarkRecovery,
  demotionTriggerFailureAlert,
  demotionTriggerFailureRecovery,
  demotionRerouteOutcomeInfo,
} from "@/lib/monitor/cron-alert-copy";
import { alertEntry, catalogEntryForSentKey } from "@/lib/notify/alert-catalog";
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
  // #2774: it pages only on the second consecutive failed run, so it says so, or a
  // reader takes it for a single blip and waits for the next hour to clear it.
  assert(/two runs in a row/.test(text), "the page says the read failed on consecutive runs, not once");
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

// --- the writes that did not land (#2114) ---------------------------------------
// The read failing is already paged. What was not is the half AFTER the read: a
// flip that keeps throwing, a coverage sweep that could not be queued, and an
// attribute write that would not land. Each was counted, written to the log, put in the sync banner, and
// reported by nothing on an unattended hourly run.

{
  const text = twilioWriteFailureAlert({ flips: 2, sweeps: 0, attributes: 0 });
  assert(/still bookable|still be booked|still offering/i.test(text), "a failed flip leads with the consequence, which is an agent Slate is still offering");
  assert(text.includes("2"), "and says how many");
  assert(!/coverage sweep|routing attributes/i.test(text), "and says nothing about the two that did not happen");
}

{
  const text = twilioWriteFailureAlert({ flips: 0, sweeps: 1, attributes: 0 });
  assert(/upcoming|booked|call/i.test(text), "a failed coverage sweep is about the calls left behind");
  assert(/coverage/i.test(text), "and names where to go and move them");
  assert(!/still bookable/i.test(text), "and does not claim an agent is still being offered, which is a different fault");
}

{
  const text = twilioWriteFailureAlert({ flips: 0, sweeps: 0, attributes: 3 });
  assert(/routing attributes/i.test(text), "a failed attribute write says which facts did not land");
  assert(/debt tier/i.test(text), "naming them, since #2152 put three facts in one write and a reader has to know which are stale");
  assert(text.includes("3"), "and how many agents it covers");
}

{
  // All three at once. The flip leads, because it is the only one of the four that
  // misroutes a lead today (L609), and every count is still named rather than one
  // answering for the others (L11).
  const text = twilioWriteFailureAlert({ flips: 1, sweeps: 2, attributes: 3 });
  const flipAt = text.search(/still bookable|still be booked|still offering/i);
  const sweepAt = text.search(/coverage/i);
  assert(flipAt >= 0 && sweepAt > flipAt, `the flip is said first (got: ${text})`);
  for (const n of ["1", "2", "3"]) assert(text.includes(n), `the count ${n} survives into the message`);
}

{
  const text = twilioWriteFailureRecovery();
  assert(/no action/i.test(text), "the all clear says nothing is owed");
  assert(!/[0-9]/.test(text), "and quotes no count, because the run that cleared it measured none");
}

// --- a mark Twilio no longer has a worker for (#2114) ---------------------------
{
  const text = twilioOrphanedMarkAlert(3);
  assert(text.includes("3"), "the count is named");
  assert(/not bookable|out of the (bookable )?pool/i.test(text), "the consequence is that they are held out of the pool");
  assert(
    /Twilio/.test(text) && /worker/i.test(text),
    "and the cause is that Twilio holds no worker for them, which is where the repair is",
  );
  assert(
    !/press|sync again/i.test(text),
    "it does NOT tell somebody to press sync again: re-running changes nothing while the worker is missing (L111)",
  );
}

{
  const one = twilioOrphanedMarkAlert(1);
  assert(/\b1 agent\b/.test(one), `one agent reads as singular (got: ${one})`);
  assert(!/1 agents/.test(one), "not as a plural with a one in front of it");
}

{
  const text = twilioOrphanedMarkRecovery();
  assert(/no action/i.test(text), "the all clear says nothing is owed");
}

// --- both are conditions, so both must resolve ----------------------------------
{
  for (const key of ["twilio_write_failures", "twilio_marked_no_worker"]) {
    const entry = alertEntry(key);
    assert(entry !== undefined, `${key} is in the catalog`);
    eq(entry?.kind, "condition", `${key} is a condition: it is an ongoing state a later run ends`);
    assert((entry?.why ?? "").length > 20, `${key} says why it is classified that way`);
  }
}

// --- #3615: the reroute for demoted advisors could not finish ---------------------
{
  const none = { switchUnreadable: false, evals: 0, sweeps: 0, writes: 0 };
  const sw = demotionTriggerFailureAlert({ ...none, switchUnreadable: true });
  assert(/switched on|switch/i.test(sw), `an unreadable switch is named as the switch (got: ${sw})`);
  assert(/nobody|no one|no agent/i.test(sw), "and says the consequence: nobody was checked");

  const ev = demotionTriggerFailureAlert({ ...none, evals: 2 });
  assert(/\b2 agents\b/.test(ev), `the count of agents not checked is named (got: ${ev})`);
  assert(/still with them|may still/i.test(ev), "and the consequence: a call they can no longer take may still be theirs");

  const sweep = demotionTriggerFailureAlert({ ...none, sweeps: 1 });
  assert(/\b1 agent\b/.test(sweep), `one agent reads as singular (got: ${sweep})`);
  assert(/coverage panel/i.test(sweep), "a move that could not be queued names where to move the calls by hand");

  const wr = demotionTriggerFailureAlert({ ...none, writes: 3 });
  assert(wr.includes("3"), "a record that could not be saved is counted");

  const all = demotionTriggerFailureAlert({ switchUnreadable: true, evals: 1, sweeps: 2, writes: 3 });
  for (const n of ["1", "2", "3"]) assert(all.includes(n), `the count ${n} survives into the combined message`);
  assert(/tag=twilio-sync/.test(all), "and it points at the logs where each failure is written");
  assert(!/^Slate/.test(all), "and does not open with Slate, which the Slack header already says");

  const rec = demotionTriggerFailureRecovery();
  assert(/no action/i.test(rec), "the all clear says nothing is owed");
  assert(!/[0-9]/.test(rec), "and quotes no count");

  for (const key of ["demotion_trigger_failures", "demotion_reroute_moved:u1"]) {
    const entry = catalogEntryForSentKey(key);
    assert(entry !== undefined, `${key} is classified in the alert catalog`);
  }
  eq(alertEntry("demotion_trigger_failures")?.kind, "condition", "the failure is a condition that ends");
  eq(catalogEntryForSentKey("demotion_reroute_moved:u1")?.kind, "info", "the moved line is a whisper, never a page");
}

// --- #3615: the Slack line once a demotion sweep has FINISHED -----------------------------
//
// It used to go out when the sweep was queued and say "is moving 1 call" for a call nobody was
// free to take (evaldez1, 2026-10-21). It is now written from the settled counts, so it says what
// happened, and "narrowed" rather than "demoted", since a narrowing is sometimes a correction.
{
  const change = { from: { debtTeam: ["medium", "low"], backendService: ["achieve"] }, to: { debtTeam: ["medium"], backendService: ["achieve"] } };
  const counts = { moved: 0, unplaceable: 0, failed: 0, skipped: 0, cancelled: 0 };
  const url = "https://slate.trypennie.app/admin/agents/u1?job=j1";
  const line = (c: Partial<typeof counts>, ch: typeof change | null = change) =>
    demotionRerouteOutcomeInfo({ email: "evaldez1@trypennie.com", change: ch, counts: { ...counts, ...c }, url });

  const stranded = line({ unplaceable: 1 });
  assert(!/moving/i.test(stranded), `a call that did not move is never said to be moving (got: ${stranded})`);
  assert(!/demot/i.test(stranded), "and the change is not called a demotion");
  assert(/narrowed/.test(stranded) && stranded.includes("evaldez1@trypennie.com"), "it says whose tiers narrowed");
  assert(stranded.includes("Debt tiers went from Medium and Low to Medium."), "and what changed, in the shared sentence");
  assert(/None moved/.test(stranded), "it says nothing moved");
  assert(/1 stayed with them because no other advisor was free/.test(stranded), "and why the call stayed");
  assert(/every hour/.test(stranded), "and that Slate tries again");
  assert(stranded.includes(url), "and links the sweep");

  const one = line({ moved: 1 });
  assert(/It moved to another advisor\./.test(one) && !/stayed/.test(one), `a single moved call says so plainly (got: ${one})`);

  const all = line({ moved: 3 });
  assert(/All 3 moved to other advisors\./.test(all), `every call moved reads as all (got: ${all})`);
  assert(/\b3 calls\b/.test(all), "and counts the calls it needed to move");

  const mixed = line({ moved: 2, unplaceable: 1, failed: 2, skipped: 1, cancelled: 1 });
  assert(/2 of 7 moved to other advisors\./.test(mixed), `a partial result gives moved of total (got: ${mixed})`);
  assert(/2 could not be moved because of an error/.test(mixed), "an errored move is said apart from a busy roster");
  assert(/coverage page will ask a person to move them/.test(mixed), "and points at the page that asks a person, since this line is only an FYI");
  assert(/2 no longer needed moving/.test(mixed), "and a cancelled call or a stopped sweep apart again");

  assert(/not recorded/i.test(line({ moved: 1 }, null)), "an unrecorded change says so rather than inventing one");
  assert(!/[\u2014\u2013]/.test(mixed + stranded), "no dash punctuation");
}

finish();
