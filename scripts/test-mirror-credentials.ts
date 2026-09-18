// A credential cannot join the Snowflake mirror unnoticed (#2564).
//
// The mirror carried `bookings.manage_token`: not a description of the person but
// a credential, since whoever holds it can reschedule or cancel that booking with
// no other authentication. The warehouse has a wider and different audience than
// Slate's database, so mirroring it made warehouse read access equal to booking
// control access.
//
// The export redaction stops it leaving, and the sweep clears what already left.
// Neither can stop somebody adding the NEXT one. This guard is what does: every
// exported column whose name reads like a credential must either be declared in
// MIRROR_CREDENTIALS (and therefore stripped and swept) or be named here with a
// reason saying why it is not one.
//
// An allowlist entry is written as the REASON the column is not a credential, not
// as a bare name, because the question the next reader has to answer is whether
// THEIR new column belongs here, and a name answers nothing (L362).
//
// Run: node --experimental-strip-types scripts/test-mirror-credentials.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { MIRROR_TABLES } from "../src/lib/snowflake/export-core.ts";
import {
  MIRROR_CREDENTIALS,
  redactMirrorCredentials,
} from "../src/lib/snowflake/mirror-credentials.ts";

/** A column name that reads like something whose POSSESSION grants an ability. */
const CREDENTIAL_SHAPED = /(^|_)(token|secret|password|passwd|credential|apikey|signature)(s)?($|_)|(^|_)key($|_)/i;

/**
 * Exported columns that MATCH the pattern and are deliberately not credentials.
 * Each entry says what the value is and why holding it grants nothing.
 */
const NOT_A_CREDENTIAL: Record<string, string> = {
  "bookings.idempotency_key":
    "a caller supplied de-duplication key. It selects which booking a repeated request refers to and authorises nothing: every route that reads it also authenticates separately.",
};

// --- the pattern finds the thing it was written for ---------------------------
// Without this the guard could pass on a pattern that matches nothing at all,
// which reads exactly like a mirror carrying no credentials (L1, L98).
assert(CREDENTIAL_SHAPED.test("manage_token"), "the pattern recognises manage_token");
assert(CREDENTIAL_SHAPED.test("api_key"), "the pattern recognises api_key");
assert(CREDENTIAL_SHAPED.test("webhook_secret"), "the pattern recognises webhook_secret");
assert(!CREDENTIAL_SHAPED.test("keyword"), "the pattern does not fire on a word that merely contains key");
assert(!CREDENTIAL_SHAPED.test("attendee_email"), "the pattern does not fire on ordinary contact data");

// --- every declared credential is real ----------------------------------------
// An entry naming a column the mirror does not export would be a rule about
// nothing, while making the list look complete.
for (const c of MIRROR_CREDENTIALS) {
  const spec = MIRROR_TABLES.find((t) => t.table === c.table);
  assert(spec != null, `${c.table} is a mirrored table`);
  assert(
    spec?.cols.some((col) => col.name === c.column) === true,
    `${c.table}.${c.column} is a column the mirror exports`,
  );
  assert(
    c.why.trim().length > 20,
    `${c.table}.${c.column} says what holding the value lets somebody do`,
  );
}

// --- and nothing credential-shaped is exported undeclared ---------------------
const declared = new Set(MIRROR_CREDENTIALS.map((c) => `${c.table}.${c.column}`));
const undeclared: string[] = [];
for (const spec of MIRROR_TABLES) {
  for (const col of spec.cols) {
    const name = `${spec.table}.${col.name}`;
    if (!CREDENTIAL_SHAPED.test(col.name)) continue;
    if (declared.has(name)) continue;
    if (NOT_A_CREDENTIAL[name]) continue;
    undeclared.push(name);
  }
}
eq(
  undeclared.length,
  0,
  `every credential-shaped mirrored column is declared or reasoned about (undeclared: ${undeclared.join(", ") || "none"})`,
);

// Every allowlist entry must still be a column the mirror exports, or it is a
// standing exemption for something that no longer exists, quietly covering a
// future column that takes the same name.
for (const name of Object.keys(NOT_A_CREDENTIAL)) {
  const [table, column] = name.split(".");
  const spec = MIRROR_TABLES.find((t) => t.table === table);
  assert(
    spec?.cols.some((c) => c.name === column) === true,
    `the exemption for ${name} is about a column the mirror still exports`,
  );
  assert(
    NOT_A_CREDENTIAL[name].trim().length > 20,
    `the exemption for ${name} carries a reason, not just a name`,
  );
}

// --- the redaction actually strips, on both shapes ----------------------------
// The declaration is only worth anything if the thing reading it removes the
// value. Drive both shapes rather than trusting the list.
for (const c of MIRROR_CREDENTIALS) {
  const row: Record<string, unknown> = { id: "row-1" };
  row[c.column] = c.jsonKey ? { booking_id: "bk1", [c.jsonKey]: "SECRET-VALUE" } : "SECRET-VALUE";
  const [out] = redactMirrorCredentials(c.table, [row]);
  assert(
    !JSON.stringify(out).includes("SECRET-VALUE"),
    `${c.table}.${c.column}${c.jsonKey ? `:${c.jsonKey}` : ""} is stripped by the redaction`,
  );
  assert(out.id === "row-1", `${c.table} redaction leaves the row id, which the export cursor reads`);
}

// --- the positive control -----------------------------------------------------
// A scan over a list that happened to hold nothing credential-shaped, and a scan
// that reads nothing at all, produce the same empty result. Plant one.
const planted = [
  ...MIRROR_TABLES.map((t) => ({ ...t, cols: [...t.cols] })),
  { table: "planted", watermark: "created_at" as const, cols: [{ name: "id", type: "varchar" as const }, { name: "reset_token", type: "varchar" as const }] },
];
const caught = planted.flatMap((spec) =>
  spec.cols
    .filter((col) => CREDENTIAL_SHAPED.test(col.name))
    .map((col) => `${spec.table}.${col.name}`)
    .filter((name) => !declared.has(name) && !NOT_A_CREDENTIAL[name]),
);
eq(caught.length, 1, "the scan catches a credential-shaped column added to the mirror");
eq(caught[0], "planted.reset_token", "and names the column it caught");

finish();
