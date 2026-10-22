// #1825: a page and a whisper used to arrive in the same channel looking exactly
// alike, so a reader mid incident had to parse a paragraph before learning whether
// anything was asked of them. Every message the dispatcher posts now opens with a
// lead line saying so, chosen by ONE pure rule from the sender (page, whisper or
// all clear) and the catalog classification. This pins that rule:
//
//   1. a whisper, and any key the catalog calls info, reads as needing nothing,
//      whichever sender carried it;
//   2. an urgent condition reads as urgent, and every other page as needing attention;
//   3. an all clear reads as resolved;
//   4. a key the catalog does not classify reads as a page (the loud direction);
//   5. the leads are pairwise distinct, sit on one line, set a whisper quieter than
//      a page, and never open with the word Slate (the style gate covers dashes);
//   6. the lead is added in front of the text and leaves the text itself untouched,
//      so a reminder line, a subject list or a mention keeps its place under it.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-alert-severity-lead.ts
import {
  SEVERITY_LEADS,
  severityOf,
  withSeverityLead,
  withoutSeverityLead,
} from "../src/lib/notify/severity-lead.ts";
import { alertKindOf } from "../src/lib/notify/alert-catalog.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// Positive controls: the keys used below are classified as the test assumes.
eq(alertKindOf("reassign-unknown-reason-code"), "info", "control: an info key");
eq(alertKindOf("sync_failures"), "condition", "control: a plain condition");
eq(alertKindOf("empty_tier:low"), "condition", "control: an urgent family member");
eq(alertKindOf("verify_on_book_outage"), "incident", "control: an incident");
eq(alertKindOf("no_such_key_anywhere"), undefined, "control: an unclassified key");

// 1
eq(severityOf("sync_failures", "info"), "whisper", "a condition sent as a whisper reads as a whisper");
eq(severityOf("reassign-unknown-reason-code", "page"), "whisper", "an info key reads as a whisper even through the page sender");
eq(severityOf("reassign-unknown-reason-code", "info"), "whisper", "an info key through the info sender is a whisper");

// 2
eq(severityOf("empty_tier:low", "page"), "urgent", "an urgent condition reads as urgent");
eq(severityOf("sync_failures", "page"), "attention", "a plain condition reads as needing attention");
eq(severityOf("verify_on_book_outage", "page"), "attention", "an incident reads as needing attention");

// 3
eq(severityOf("sync_failures", "recovery"), "resolved", "an all clear reads as resolved");
eq(severityOf("empty_tier:low", "recovery"), "resolved", "an urgent condition's all clear reads as resolved, not urgent");

// 4
eq(severityOf("no_such_key_anywhere", "page"), "attention", "an unclassified key reads as a page");

// 5
const leads = Object.values(SEVERITY_LEADS);
eq(new Set(leads).size, leads.length, "every severity has its own lead");
for (const [severity, lead] of Object.entries(SEVERITY_LEADS)) {
  assert(!lead.includes("\n"), `${severity} lead is one line`);
  assert(!/^\W*slate/i.test(lead), `${severity} lead does not open with Slate`);
}
assert(/urgent/i.test(SEVERITY_LEADS.urgent), "the urgent lead says urgent");
assert(/no action/i.test(SEVERITY_LEADS.whisper), "the whisper lead says no action is needed");
assert(!/no action/i.test(SEVERITY_LEADS.attention), "a page lead never says no action");
// A whisper is set quieter than a page: italic, where every page and the all clear are bold.
assert(/^_.*_$/.test(SEVERITY_LEADS.whisper), "the whisper lead is italic");
for (const s of ["urgent", "attention", "resolved"] as const) {
  assert(/^\*[^*]+\*/.test(SEVERITY_LEADS[s]), `the ${s} lead opens in bold`);
}

// 6
const body = "Reminder: still true after 24 hours, with nothing new since the last message.\n<!channel> 2 lanes";
const posted = withSeverityLead(body, "sync_failures", "page");
eq(posted, `${SEVERITY_LEADS.attention}\n${body}`, "the lead sits on its own line above the untouched text");
eq(
  withSeverityLead("x", "reassign-unknown-reason-code", "page").split("\n")[0],
  SEVERITY_LEADS.whisper,
  "the first line of a whisper is the whisper lead",
);

// The reader's side: a post's lead comes off exactly, and text with no lead is refused.
eq(withoutSeverityLead(posted), body, "the lead comes back off the posted text");
eq(withoutSeverityLead(body), null, "text opening with something else has no lead to take off");
eq(withoutSeverityLead(SEVERITY_LEADS.resolved), null, "a lead with nothing under it is not a post");

finish();
