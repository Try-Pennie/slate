// Repo invariant (#1663): every writer of `users.email` normalises through ONE
// helper, and every read that looks a person up by address asks with the same
// normalised value.
//
// Run: node --experimental-strip-types scripts/test-email-normalization.ts
//
// Why a guard rather than trusting the three call sites. `users.email` is unique
// but CASE SENSITIVE and Google addresses are not, so a writer that skips the
// helper does not fail: it creates a SECOND row for one person, which passes
// users_email_key because the two strings genuinely differ, and the roster, the
// bookable pool, the manager link and every per agent count then resolve to
// whichever half they happen to find. Nothing reports it.
//
// `users_email_lower_idx` (migration 0112) is the backstop and is deliberately not
// the mechanism. If a writer stopped normalising, the index would turn a silent
// duplicate into a HARD FAILURE at login, which is better but is still an outage
// for the person signing in. This keeps the writers correct so the index never has
// to fire.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { normalizeEmail } from "../src/lib/auth/email.ts";
import { normalizeStaffEmail } from "../src/lib/admin/staff-access.ts";

const ROOT = join(import.meta.dirname, "..");

// --- the helper itself ------------------------------------------------------

eq(normalizeEmail("  Geoff.Smith@TryPennie.com "), "geoff.smith@trypennie.com",
  "case and surrounding whitespace are both removed");
eq(normalizeEmail(""), "", "an empty address stays empty rather than becoming a value");
eq(normalizeEmail(undefined as unknown as string), "",
  "a missing address does not throw on the login path");

// Deliberately NOT dot and plus folding. `emailLocalKey` in pending-access.ts does
// strip those, but that is a SUGGESTION engine looking for a likely typo. Folding
// them here would merge two addresses a Workspace admin can genuinely issue to two
// different people, which is the worse direction to be wrong in.
eq(normalizeEmail("geoff.smith@trypennie.com"), "geoff.smith@trypennie.com",
  "dots are preserved, because two dotted addresses can be two real people");
eq(normalizeEmail("geoff+slate@trypennie.com"), "geoff+slate@trypennie.com",
  "a plus tag is preserved for the same reason");

// One normaliser, not two that agree today. A second copy of the rule is how two
// writers drift apart while each reads as correct (L263).
eq(normalizeStaffEmail, normalizeEmail,
  "the team access grant uses the shared normaliser rather than its own copy");

// --- every writer of users.email goes through it ----------------------------
//
// Derived by scanning src/ for a users write carrying an `email` field, not from a
// list of files (L96): a fourth writer added later is covered by construction
// rather than by somebody remembering this issue.

/** Comments stripped, so prose about a write is never mistaken for one (L518). */
const codeOnly = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

/**
 * The writes this guard is about: an `.insert(` or `.upsert(` reached from a
 * `.from("users")`.
 *
 * The chain has to be walked rather than the file searched, because every one of
 * these files also READS users and inserts into other tables, and a file-level
 * "has a users read and has an insert" question calls four read-only modules
 * writers (measured: booking/service.ts, google/sync.ts,
 * monitor/availability-truth-store.ts and ooo/service.ts all matched it). So the
 * window runs from the `.from("users")` to the NEXT `.from(`, which is where that
 * chain ends.
 *
 * The `email` field itself is asked for at FILE level, not inside the window,
 * because the payload is routinely built lines away from the call: the Salesforce
 * sync pushes rows onto an array in one function and inserts the array in another,
 * so a window narrow enough to be a real chain can never see the field.
 */
function writesUserEmail(code: string): boolean {
  if (!/\bemail\b/.test(code)) return false;
  const from = /\.from\(["']users["']\)/g;
  for (let m = from.exec(code); m; m = from.exec(code)) {
    const rest = code.slice(m.index + m[0].length);
    const end = rest.search(/\.from\(/);
    const chain = end === -1 ? rest : rest.slice(0, end);
    if (/\.\s*(?:insert|upsert)\s*\(/.test(chain)) return true;
  }
  return false;
}

const writers = tsFilesUnder("src")
  .filter((f) => writesUserEmail(codeOnly(readFileSync(f, "utf8"))))
  .map((f) => f.slice(ROOT.length + 1));

// If this ever finds nothing, the scan broke: an empty result and a compliant tree
// render identically (L98).
assert(writers.length >= 3, `the sweep really found the users.email writers (${writers.length}): ${writers.join(", ")}`);

const offenders = writers.filter(
  (f) => !/normalizeEmail|normalizeStaffEmail/.test(codeOnly(readFileSync(join(ROOT, f), "utf8"))),
);
assert(
  offenders.length === 0,
  `every users.email writer normalises; these do not: ${offenders.join(", ")}`,
);

// The three known today, named as well as derived, so a scan that silently stopped
// matching one of them cannot read as a clean tree by finding only the other two.
for (const expected of [
  "src/lib/provision.ts",
  "src/lib/salesforce/sync.ts",
  "src/app/admin/actions.ts",
]) {
  assert(writers.includes(expected), `${expected} is still seen as a users.email writer`);
}

// --- positive controls ------------------------------------------------------
//
// Both directions of the detector, because a predicate that matched nothing and a
// tree with no writers produce the same empty list.
assert(
  writesUserEmail(`await db.from("users").insert({ org_id: o, email, role: "agent" });`),
  "positive control: a plain users insert carrying an address is seen as a writer",
);
assert(
  !writesUserEmail(`await db.from("users").update({ role: next }).eq("id", id);`),
  "negative control: a role update is not a writer of the address",
);
assert(
  !writesUserEmail(`await db.from("bookings").insert({ email });`),
  "negative control: another table's insert is out of scope",
);
// The one that actually cost a false positive: a file that READS users and
// inserts into a different table is not a writer of the address.
assert(
  !writesUserEmail(
    `const u = await db.from("users").select("id").eq("email", email).maybeSingle();\n` +
      `await db.from("agent_calendars").insert({ user_id: u.id, email });`,
  ),
  "negative control: a users READ beside another table's insert is not a users write",
);
assert(
  !/normalizeEmail/.test(codeOnly(`// normalizeEmail belongs here\nconst e = raw.toLowerCase();\n`)),
  "negative control: a comment naming the normaliser is not a use of it",
);

// The overlay control, which is what proves the sweep rather than the regexes: take
// the REAL provisioning source, strip the normaliser out of it in memory, and
// require the same predicate to call that file an offender.
{
  const real = readFileSync(join(ROOT, "src/lib/provision.ts"), "utf8");
  const stripped = codeOnly(real).replace(/normalizeEmail/g, "String");
  assert(
    writesUserEmail(stripped) && !/normalizeEmail|normalizeStaffEmail/.test(stripped),
    "overlay control: the real provisioning file with the normaliser removed is caught as an offender",
  );
}

// --- the migration that backs it is present ---------------------------------
//
// The guard above keeps the writers honest; this keeps the database's own refusal
// from being quietly deleted, which is the difference between a silent duplicate
// and a loud one.
{
  const dir = join(ROOT, "supabase/migrations");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  assert(
    /create unique index[\s\S]{0,80}users_email_lower_idx[\s\S]{0,120}lower\(email\)/i.test(sql),
    "a unique index on lower(email) is still in the migrations, as the backstop for a writer that skipped the helper",
  );
}

finish();
