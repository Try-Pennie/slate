// The seeded reminder emails in migration 0211 are DEFAULT_TEMPLATES, word for word (#4296).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reminder-seed-matches-templates.ts
//
// The migration seeds the 24 hour and 1 hour emails that phase 2's parity test proves
// render as today's emails. That proof is about DEFAULT_TEMPLATES, so it only covers
// production while the seed holds the same text. Two copies with nothing binding them
// drift silently (L370), so this reads the migration and holds it to the constant.
import { readFileSync } from "node:fs";
import { DEFAULT_TEMPLATES } from "../src/lib/booking/reminder-template.ts";
import { eq, finish } from "./lib/harness.ts";

const sql = readFileSync("supabase/migrations/0211_editable_reminder_emails.sql", "utf8");

/** Every `$tpl$...$tpl$` block, in the order the seed rows write them. */
const blocks = [...sql.matchAll(/\$tpl\$([\s\S]*?)\$tpl\$/g)].map((m) => m[1]);

eq(blocks.length, 4, "the seed holds a subject and a body for each of the two emails");
eq(blocks[0], DEFAULT_TEMPLATES.day.subject, "the 24 hour subject is the default template's");
eq(blocks[1], DEFAULT_TEMPLATES.day.body, "the 24 hour body is the default template's");
eq(blocks[2], DEFAULT_TEMPLATES.hour.subject, "the 1 hour subject is the default template's");
eq(blocks[3], DEFAULT_TEMPLATES.hour.body, "the 1 hour body is the default template's");

for (const t of [DEFAULT_TEMPLATES.day, DEFAULT_TEMPLATES.hour]) {
  const row = new RegExp(`\\('${t.slug}', '([^']*)', (\\d+), '(\\w+)'`).exec(sql);
  eq(
    row && { name: row[1], minutes: Number(row[2]), late: row[3] },
    { name: t.name, minutes: t.minutesBefore, late: t.lateBooking },
    `the ${t.slug} row's name, timing and late booking choice are the default template's`,
  );
}

finish();
