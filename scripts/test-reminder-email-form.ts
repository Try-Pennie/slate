// #4299: the reminder email editor's rules, shared by the page and the save.
//
// The picker offers what the save accepts and nothing else, a fill-in problem names
// the fill-in, a new email gets a key the database check accepts, and the question
// about calls already inside the window is asked exactly when a save opens a fresh one.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reminder-email-form.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  LATE_BOOKING_CHOICES,
  REMINDER_FIELDS,
  freshWindowMessage,
  listWords,
  opensFreshWindow,
  parseReminderEmailForm,
  readSnapshot,
  restoreChanges,
  slugForNewEmail,
} from "../src/lib/admin/reminder-email-form.ts";

const good: Record<string, string> = {
  [REMINDER_FIELDS.name]: "2 hour reminder",
  [REMINDER_FIELDS.hours]: "2",
  [REMINDER_FIELDS.minutes]: "0",
  [REMINDER_FIELDS.lateBooking]: "skip",
  [REMINDER_FIELDS.enabled]: "true",
  [REMINDER_FIELDS.subject]: "Your Pennie call is {when}",
  [REMINDER_FIELDS.body]: "Hi, {call with} is {when}.\r\n\r\n{signature}",
  [REMINDER_FIELDS.cardBlock]: "true",
  [REMINDER_FIELDS.placeholderSends]: "false",
};
const parse = (over: Record<string, string | null>) => {
  const all: Record<string, string | null> = { ...good, ...over };
  return parseReminderEmailForm((k) => all[k] ?? null);
};

const ok = parse({});
assert(ok.ok, "a good form parses");
if (ok.ok) {
  eq(ok.value.minutesBefore, 120, "2 hours is 120 minutes");
  eq(ok.value.body, "Hi, {call with} is {when}.\n\n{signature}", "CRLF line endings are stored as LF");
  eq(ok.value.enabled, true, "a switch posting true is on");
  eq(ok.value.placeholderSends, false, "a switch posting false is off");
}

const unknown = parse({ [REMINDER_FIELDS.body]: "Hi {advisor name} and {phone}" });
assert(!unknown.ok, "an unknown fill-in is refused");
if (!unknown.ok) {
  assert(unknown.reasons.some((r) => r.includes("{advisor name}")), "the refusal names the first unknown fill-in");
  assert(unknown.reasons.some((r) => r.includes("{phone}")), "and the second one too");
}
const malformed = parse({ [REMINDER_FIELDS.subject]: "Your call {when" });
assert(!malformed.ok && malformed.reasons.some((r) => r.includes("brace")), "a malformed brace is refused");
const late = parse({ [REMINDER_FIELDS.lateBooking]: "send_later" });
assert(!late.ok, "a late booking choice outside the picker is refused");
eq(LATE_BOOKING_CHOICES.map((c) => c.value).join(","), "send_now,skip", "the picker offers the two choices the database check holds");
const sql = readFileSync(join(import.meta.dirname, "..", "supabase", "migrations", "0211_editable_reminder_emails.sql"), "utf8");
assert(/late_booking\s+text not null check \(late_booking in \('send_now', 'skip'\)\)/.test(sql), "and the check holds exactly those two");
assert(!parse({ [REMINDER_FIELDS.name]: "   " }).ok, "a blank name is refused");
assert(!parse({ [REMINDER_FIELDS.hours]: "49" }).ok, "a timing past 48 hours is refused");

// Keys for new emails, held to the database's own pattern.
const SLUG = /^[a-z][a-z0-9_]{0,39}$/;
const taken = new Set(["day", "hour", "two_hour_reminder"]);
eq(slugForNewEmail("Two hour reminder", taken), "two_hour_reminder_2", "a taken key gets a number");
eq(slugForNewEmail("2 hour reminder!", taken), "hour_reminder", "leading digits are dropped, the key starts with a letter");
eq(slugForNewEmail("???", taken), "reminder", "a name with no letters still gets a key");
for (const name of ["A".repeat(200), "Last call, really (final)", "  day  ", "48"]) {
  const slug = slugForNewEmail(name, taken);
  assert(SLUG.test(slug) && !taken.has(slug), `"${name.slice(0, 20)}" becomes a key the database accepts (${slug})`);
}

// The window question.
assert(opensFreshWindow({ enabled: false, minutesBefore: 60 }, { enabled: true, minutesBefore: 60 }), "switching on asks");
assert(opensFreshWindow({ enabled: true, minutesBefore: 60 }, { enabled: true, minutesBefore: 90 }), "retiming an email that is on asks");
assert(!opensFreshWindow({ enabled: true, minutesBefore: 60 }, { enabled: true, minutesBefore: 60 }), "a copy edit does not ask");
assert(!opensFreshWindow({ enabled: false, minutesBefore: 60 }, { enabled: false, minutesBefore: 90 }), "retiming an email that is off does not ask");
assert(!opensFreshWindow({ enabled: true, minutesBefore: 60 }, { enabled: false, minutesBefore: 60 }), "switching off does not ask");
const msg = freshWindowMessage("1 hour reminder", { enabled: false, minutesBefore: 60 }, { enabled: true, minutesBefore: 60 });
assert(msg.includes("1 hour reminder") && msg.includes("less than 1 hour away will not get it"), `the sentence names the email and who misses it: ${msg}`);
const moved = freshWindowMessage("1 hour reminder", { enabled: true, minutesBefore: 60 }, { enabled: true, minutesBefore: 90 });
assert(moved.startsWith('Moving "1 hour reminder" to 1 hour 30 minutes'), `a retime names the new timing: ${moved}`);

// Restore.
const copy = { subject: "a", body: "b", card_block: true, placeholder_sends: true };
eq(restoreChanges(copy, { ...copy, body: "c", card_block: false }).join("|"), "the body|the contact card switch", "restore lists only what changes");
eq(restoreChanges(copy, copy).length, 0, "restoring the current copy changes nothing");
eq(readSnapshot({ subject: "a", body: "b", card_block: true }), null, "a snapshot missing a field is refused");
eq(JSON.stringify(readSnapshot(copy)), JSON.stringify(copy), "a whole snapshot is read");
eq(listWords(["a", "b", "c"]), "a, b and c", "words joined for a sentence");

finish();
