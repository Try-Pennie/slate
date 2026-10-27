// #4296: the timing an admin may give a reminder email, held to ONE set of numbers.
//
// `reminder_emails.minutes_before` is bounded by a check constraint in migration 0211,
// and the editor (phase 4) and the lane (phase 3) read the same bounds from
// src/lib/booking/reminder.ts. Two copies of a number drift silently (L370): a check
// looser than the code lets a hand edit store a timing the lane then refuses, and a
// tighter one refuses a save the editor offered. So this reads the constraint out of
// the migration and holds it to the constants.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reminder-email-bounds.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  HOUR_REMINDER_MIN_LEAD_MS,
  REMINDER_EMAIL_MAX_MINUTES,
  REMINDER_EMAIL_MIN_MINUTES,
} from "../src/lib/booking/reminder.ts";

const sql = readFileSync(join(import.meta.dirname, "..", "supabase", "migrations", "0211_editable_reminder_emails.sql"), "utf8");

const check = /minutes_before\s+integer\s+not null\s+check\s*\(\s*minutes_before\s*>=\s*(\d+)\s+and\s+minutes_before\s*<=\s*(\d+)\s*\)/.exec(sql);
assert(check !== null, "migration 0211 bounds minutes_before with a check the guard can read");
if (check) {
  eq(Number(check[1]), REMINDER_EMAIL_MIN_MINUTES, "the check's floor is REMINDER_EMAIL_MIN_MINUTES");
  eq(Number(check[2]), REMINDER_EMAIL_MAX_MINUTES, "the check's ceiling is REMINDER_EMAIL_MAX_MINUTES");
}
eq(REMINDER_EMAIL_MIN_MINUTES, HOUR_REMINDER_MIN_LEAD_MS / 60_000, "the floor is the 30 minute minimum the lane already holds (#4287)");
eq(REMINDER_EMAIL_MAX_MINUTES, 48 * 60, "the ceiling is 48 hours (Dan, 2026-10-27)");

finish();
