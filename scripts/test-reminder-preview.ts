// #4299: the sample calls the reminder email editor previews and sends a test from.
//
// The preview is what an admin reads before switching an email on, so it has to be
// what a lead would receive: the same renderer the lane uses, the advisor's mailbox
// as the sender, and the card only when the words that explain it are there. These
// pin each of the five cases against the real DEFAULT_TEMPLATES, and the timing
// boxes against the bounds the database check holds.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reminder-preview.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  PREVIEW_CASES,
  SAMPLE_ADVISOR,
  SAMPLE_PLACEHOLDER,
  joinMinutes,
  previewCase,
  previewReminder,
  splitMinutes,
  timingWords,
  type ReminderDraft,
} from "../src/lib/booking/reminder-preview.ts";
import { DEFAULT_TEMPLATES } from "../src/lib/booking/reminder-template.ts";
import { REMINDER_EMAIL_MAX_MINUTES, REMINDER_EMAIL_MIN_MINUTES } from "../src/lib/booking/reminder.ts";

const day: ReminderDraft = { ...DEFAULT_TEMPLATES.day };
const hour: ReminderDraft = { ...DEFAULT_TEMPLATES.hour };

eq(
  PREVIEW_CASES.map((c) => c.id).join(","),
  "calling_known,calling_unknown,no_lead_number,no_advisor_name,placeholder",
  "the five cases the editor previews, the ordinary call first",
);

const at = (id: string) => {
  const c = previewCase(id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};

// The ordinary call: from the advisor, by name, with the card.
const known = previewReminder(day, at("calling_known"));
assert(known.kind === "rendered", "the ordinary call renders");
if (known.kind === "rendered") {
  eq(known.fromName, SAMPLE_ADVISOR.name, "the inbox shows the advisor's name as the sender");
  eq(known.fromAddress, SAMPLE_ADVISOR.mailbox, "it comes from the advisor's own mailbox");
  eq(known.subject, "Your Pennie call tomorrow at 2:30pm EST", "the 24 hour subject names the day, a day ahead of the sample call");
  assert(known.cardAttached, "the card goes with the copy that names the calling number");
  assert(known.body.includes("(215) 555-0199"), "the body names the number the call comes from");
  assert(known.body.includes("(215) 555-0100"), "the body names the lead's own number");
}

const unknown = previewReminder(day, at("calling_unknown"));
assert(unknown.kind === "rendered" && !unknown.cardAttached, "no calling number, no card");
assert(unknown.kind === "rendered" && !unknown.body.includes("555-0199"), "and no number the call comes from");

const noLead = previewReminder(day, at("no_lead_number"));
assert(noLead.kind === "rendered" && noLead.body.includes("the number you gave us"), "no lead number says the number they gave");

const nameless = previewReminder(day, at("no_advisor_name"));
assert(nameless.kind === "rendered", "a nameless advisor renders");
if (nameless.kind === "rendered") {
  eq(nameless.fromName, "Pennie", "the inbox shows Pennie when the advisor has no name, as the lane sends it");
  assert(nameless.body.includes("Your Pennie advisor"), "the signature speaks for Pennie");
  assert(!nameless.body.includes(SAMPLE_ADVISOR.name), "and never names the sample advisor");
}

const placeholder = previewReminder(day, at("placeholder"));
assert(placeholder.kind === "rendered", "a placeholder call renders");
if (placeholder.kind === "rendered") {
  eq(placeholder.fromAddress, SAMPLE_PLACEHOLDER.mailbox, "a placeholder call comes from the seat's mailbox");
  assert(!placeholder.cardAttached, "and never carries the card");
}
eq(previewReminder({ ...day, placeholderSends: false }, at("placeholder")).kind, "not_sent", "switched off for placeholder calls, it is not sent");

// The 1 hour email says the time until the call, from its own timing.
const soon = previewReminder(hour, at("calling_known"));
assert(soon.kind === "rendered" && soon.subject.startsWith("Your Pennie call is in about an hour"), "the 1 hour subject says how long until the call");

// A draft with a fill-in that does not exist is refused, naming it.
const typo = previewReminder({ ...day, body: "Hi {advisor}" }, at("calling_known"));
assert(typo.kind === "refused" && typo.problems.some((p) => p.kind === "unknown" && p.token === "{advisor}"), "an unknown fill-in is refused by name");

// The timing boxes.
eq(JSON.stringify(splitMinutes(90)), JSON.stringify({ hours: 1, minutes: 30 }), "90 minutes is 1 hour 30");
eq(JSON.stringify(joinMinutes("1", "30")), JSON.stringify({ ok: true, total: 90 }), "1 hour 30 is 90 minutes");
eq(JSON.stringify(joinMinutes("24", "")), JSON.stringify({ ok: true, total: 1440 }), "an empty minutes box is none");
assert(!joinMinutes("0", "60").ok, "60 minutes is refused: whole hours go in the hours box");
assert(!joinMinutes("1.5", "0").ok, "a fraction of an hour is refused");
assert(!joinMinutes("-1", "0").ok, "a negative number is refused");
assert(!joinMinutes("0", String(REMINDER_EMAIL_MIN_MINUTES - 1)).ok, "under the floor is refused");
assert(joinMinutes("0", String(REMINDER_EMAIL_MIN_MINUTES)).ok, "the floor itself is allowed");
assert(joinMinutes(String(REMINDER_EMAIL_MAX_MINUTES / 60), "0").ok, "the ceiling itself is allowed");
assert(!joinMinutes(String(REMINDER_EMAIL_MAX_MINUTES / 60), "1").ok, "past the ceiling is refused");
eq(timingWords(90), "1 hour 30 minutes", "timing in words");
eq(timingWords(1440), "24 hours", "whole hours drop the minutes");
eq(timingWords(30), "30 minutes", "minutes alone drop the hours");

finish();
