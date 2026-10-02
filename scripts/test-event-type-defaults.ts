// A new event type's defaults live in ONE place, and the add form explains its
// fields (#1950).
//
// The form used to prefill six literals in its JSX. Two of them had drifted from
// the record listed directly above them (30 minutes on a 15 minute grid, against
// a live 20 minutes on a 10 minute grid), which is what Dan read off the screen.
// A third copy sat in the create action's fallbacks and a fourth in the DDL.
//
// So this holds three things that a single edit can otherwise break apart:
//
//   the DATABASE and the constant agree, by parsing the DDL rather than by
//   somebody remembering to change both;
//   the FORM quotes the constant instead of carrying numbers of its own, and
//   ships nothing that submits a value nobody typed;
//   every non obvious field EXPLAINS itself, visibly.
//
// Run: node --experimental-strip-types scripts/test-event-type-defaults.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";
import {
  EVENT_TYPE_DEFAULTS,
  EVENT_TYPE_FIELD_NOTES,
} from "@/lib/booking/event-type-defaults";

// --- the database and the constant say the same thing ------------------------
const ddl = readFileSync(join("supabase", "migrations", "0001_init.sql"), "utf8");
const block = ddl.match(/create table event_types \(([\s\S]*?)\n\);/)?.[1] ?? "";
assert(block.length > 0, "the event_types DDL was found to compare against");

/** The DDL's own default for a column, or null when it declares none. */
function ddlDefault(column: string): string | null {
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*(\w+)\s+([\s\S]*)$/);
    if (!m || m[1] !== column) continue;
    const d = m[2].match(/default\s+('[^']*'|[\w.]+)/i);
    return d ? d[1].replace(/^'|'$/g, "") : null;
  }
  return null;
}

// The parser has to be shown finding something, or a regex that matched nothing
// would report every column as agreeing with nothing (L98).
assert(
  ddlDefault("duration_min") !== null,
  "the DDL parser reads a default it can compare (duration_min)",
);
assert(
  ddlDefault("daily_cap") === null,
  "the DDL parser reports a column with NO default as having none (daily_cap)",
);

const mismatched: string[] = [];
for (const [column, value] of Object.entries(EVENT_TYPE_DEFAULTS)) {
  const declared = ddlDefault(column);
  if (declared === null || declared !== String(value)) {
    mismatched.push(`${column}: the code says ${value}, the database says ${declared ?? "nothing"}`);
  }
}
assert(
  mismatched.length === 0,
  `every default matches the column's own DDL default:\n    ${mismatched.join("\n    ")}`,
);

// --- the form carries no numbers of its own ----------------------------------
const PAGE = join("src", "app", "admin", "event-types", "page.tsx");
const page = readFileSync(PAGE, "utf8");
const fields = [...page.matchAll(/<Field\b[\s\S]*?\/>/g)].map((m) => m[0]);
assert(fields.length >= 6, `the scanner found the form's fields (saw ${fields.length})`);

// A `defaultValue` submits when untouched, so a literal one here is a value
// nobody typed reaching the database. A placeholder does not submit, which is
// why the numbers may only appear as one.
const prefilled = fields
  .filter((f) => /defaultValue=/.test(f))
  .map((f) => f.replace(/\s+/g, " ").slice(0, 90));
assert(
  prefilled.length === 0,
  `no field submits a value nobody typed:\n    ${prefilled.join("\n    ")}`,
);

// The one that mattered most: pressing Add with nothing edited must not be able
// to create a second event type wearing an existing one's name.
const nameField = fields.find((f) => /name="name"/.test(f)) ?? "";
assert(nameField.length > 0, "the form has a Title field to judge");
assert(
  !/defaultValue=/.test(nameField),
  "the Title arrives empty, so Add cannot create a same named twin from a default",
);
assert(
  /\brequired\b/.test(nameField),
  "the Title is required, so Add refuses rather than inventing a name",
);

// --- every non obvious field explains itself ---------------------------------
const formNames = fields
  .map((f) => f.match(/name="(\w+)"/)?.[1])
  .filter((n): n is string => Boolean(n));

const orphanNotes = Object.keys(EVENT_TYPE_FIELD_NOTES).filter((k) => !formNames.includes(k));
assert(
  orphanNotes.length === 0,
  `every explanation belongs to a field that exists: ${orphanNotes.join(", ")}`,
);

// The four Dan named. `Title` and `Duration` are deliberately absent: a note
// beside a self evident field is the noise that teaches people to skip them.
const MUST_EXPLAIN = ["slot_interval_min", "min_notice_min", "gap_min", "daily_cap"];
const unexplained = MUST_EXPLAIN.filter((n) => !EVENT_TYPE_FIELD_NOTES[n]);
assert(
  unexplained.length === 0,
  `the fields whose meaning is not guessable carry a note: ${unexplained.join(", ")}`,
);

// A note that only restates the unit is the gap being closed, not a fix.
const unitOnly = Object.entries(EVENT_TYPE_FIELD_NOTES)
  .filter(([, note]) => note.trim().length < 25)
  .map(([k]) => k);
assert(
  unitOnly.length === 0,
  `each note says what the field DOES rather than naming its unit: ${unitOnly.join(", ")}`,
);

// And each note has to REACH ITS OWN FIELD. Asserting the constant is NAMED
// somewhere in the page is answered by the import line, so a form that renders
// not one hint passed this until a mutation removed all four and nothing failed.
const missingHint = MUST_EXPLAIN.filter((name) => {
  const tag = fields.find((f) => new RegExp(`name="${name}"`).test(f)) ?? "";
  return !/hint=\{EVENT_TYPE_FIELD_NOTES\./.test(tag);
});
assert(
  missingHint.length === 0,
  `each field renders its own note beside it: ${missingHint.join(", ")}`,
);
assert(
  /EVENT_TYPE_DEFAULTS/.test(page),
  "the form's placeholders come from the shared defaults",
);

// --- the create action carries no numbers of its own -------------------------
//
// A vitest assertion here is satisfied by a literal, because it compares the
// written row against the constant and the constant currently holds the same
// numbers a literal would (L70). So the single source has to be checked as a
// SOURCE fact: the action names the constant, and the numbers appear nowhere in
// its fallbacks.
const actions = readFileSync(join("src", "app", "admin", "actions.ts"), "utf8");
const body =
  actions.match(/export async function createEventType[\s\S]*?\n}\n/)?.[1 - 1] ?? "";
assert(body.length > 0, "createEventType was found to read");

const literalFallbacks = [...body.matchAll(/num\(\s*form,\s*"(\w+)",\s*(\d+)\s*\)/g)]
  // A daily cap has no default (the column is nullable and blank means no cap),
  // so its 0 is the parse fallback for a value somebody typed, not a default.
  .filter((m) => m[1] !== "daily_cap")
  .map((m) => `${m[1]} falls back to the literal ${m[2]}`);
assert(
  literalFallbacks.length === 0,
  `the action applies the shared defaults, not numbers of its own:\n    ${literalFallbacks.join("\n    ")}`,
);
assert(
  /EVENT_TYPE_DEFAULTS/.test(body),
  "the action reads the shared defaults",
);

finish();
