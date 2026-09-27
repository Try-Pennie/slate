// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-stale-slots-alert-copy.ts
//
// What the bucket_slots_stale page SAYS (#2815), read as the person on the phone
// reads it. The old wording ("3 bucket_slots row(s) stale >6m (e.g. 530, 531,
// 532); a precompute writer may be stuck.") named a table and a component, never
// said that 530 is a bucket, what a lead sees meanwhile, or whether to act or
// wait. These assertions pin the facts a reader needs, not an exact rendering, so
// a later wording refinement does not have to fight them (L103).
import {
  bucketSlotsStaleAlert,
  bucketSlotsStaleUnreadableMarkerAlert,
  bucketSlotsStaleRecovery,
} from "@/lib/monitor/cron-alert-copy";
import { assert, finish } from "./lib/harness.ts";

const DASHES = /[\u2014\u2013]|\s-\s/;

function commonChecks(text: string, label: string): void {
  assert(!/^Slate/.test(text), `${label}: does not open with Slate (the Slack header already says it)`);
  assert(!DASHES.test(text), `${label}: no dashes as punctuation`);
  assert(!/row\(s\)|precompute writer/.test(text), `${label}: no internal jargon (row(s), precompute writer)`);
  // Internal table names may appear only in the trailing "Diagnose via" pointer.
  const body = text.split("Diagnose via")[0];
  assert(!/bucket_slots|alert_state/.test(body), `${label}: no table names before the Diagnose via pointer`);
  assert(text.includes("Diagnose via"), `${label}: ends by pointing at where the detail lives`);
  // What a lead sees meanwhile, which is the reason the page matters at all.
  assert(/lead/i.test(body), `${label}: says what a lead sees meanwhile`);
  assert(/confirm/i.test(body), `${label}: says a filled time is caught when the lead confirms`);
  // Whether to wait or act.
  assert(/by itself/i.test(body), `${label}: says it can clear by itself`);
  assert(/15 minutes/.test(body), `${label}: says when to act`);
}

// Plural, every stale bucket listed: named as buckets, joined with "and".
{
  const text = bucketSlotsStaleAlert(3, 6, ["530", "531", "532"]);
  commonChecks(text, "plural");
  assert(/\b3 buckets\b/.test(text), "plural: the count is stated as buckets");
  assert(text.includes("buckets 530, 531 and 532"), "plural: names the buckets as buckets, joined with and");
  assert(!/including/.test(text), "plural: does not say 'including' when every bucket is listed");
  assert(/6 minutes/.test(text), "plural: states the threshold in minutes, not '>6m'");
}

// Singular.
{
  const text = bucketSlotsStaleAlert(1, 6, ["530"]);
  commonChecks(text, "singular");
  assert(/\b1 bucket\b/.test(text) && !/\b1 buckets\b/.test(text), "singular: '1 bucket', never '1 buckets'");
  assert(text.includes("bucket 530"), "singular: names the one bucket");
}

// More stale than examples: says the list is partial.
{
  const text = bucketSlotsStaleAlert(9, 6, ["411", "412", "511", "512", "611"]);
  assert(/\b9 buckets\b/.test(text), "partial: the full count is stated");
  assert(text.includes("including buckets 411, 412, 511, 512 and 611"), "partial: the examples are marked as a partial list");
}

// The unreadable marker sibling: same facts, plus the two possible causes.
{
  const text = bucketSlotsStaleUnreadableMarkerAlert(62, 6, ["411", "412", "511", "512", "611"], 3);
  commonChecks(text, "unreadable");
  assert(/\b62 buckets\b/.test(text), "unreadable: count stated as buckets");
  assert(text.includes("including buckets 411, 412, 511, 512 and 611"), "unreadable: partial list marked");
  assert(/3 minutes running/.test(text), "unreadable: says how long the check has been unreadable");
  assert(/booking setting/i.test(text), "unreadable: names the harmless cause (a booking settings save)");
  assert(/stuck/i.test(text), "unreadable: names the harmful cause (a stuck refresh)");
}
{
  const text = bucketSlotsStaleUnreadableMarkerAlert(1, 6, ["530"], 1);
  assert(/\b1 bucket\b/.test(text) && text.includes("bucket 530"), "unreadable singular: '1 bucket', 'bucket 530'");
  assert(/1 minute running/.test(text) && !/1 minutes/.test(text), "unreadable singular: '1 minute', never '1 minutes'");
}

// The recovery still says it is over and nothing is needed.
{
  const text = bucketSlotsStaleRecovery();
  assert(/No action is needed/.test(text), "recovery: says no action is needed");
  assert(!/precompute writer/.test(text), "recovery: no internal jargon either");
}

finish();
