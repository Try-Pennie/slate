// The operational claims the production readiness docs make, checked against the
// code they describe (#3097, #3124, #3129, #3130, #3131).
//
// Docs state testable claims (L32), and a claim nothing checks drifts the moment the
// code moves: DEPLOY.md said for weeks that there was no kill switch while one
// shipped and was proven nightly (#3129). So each claim below is read out of the doc
// and compared with the source it names, rather than restated here as a string the
// doc and the code could both drift away from.
//
// Run: node --experimental-strip-types scripts/test-ops-doc-claims.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const read = (p: string) => readFileSync(p, "utf8");

/** The text of one `## ` section of a markdown doc, heading included. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n## ${heading}`);
  if (start === -1) return "";
  const next = doc.indexOf("\n## ", start + 4);
  return doc.slice(start, next === -1 ? undefined : next);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

// --- #3124: the Worker holds no database connection of its own ------------------
// DEPLOY.md's capacity note rests the connection argument on this: every query goes
// through PostgREST over HTTPS, so a burst of isolates cannot multiply connections.
{
  const DRIVER = /(?:from\s+|require\(\s*|import\(\s*)["'](pg|postgres|pg-pool|@neondatabase\/serverless|@vercel\/postgres)["']/;
  const offenders = [...walk("src"), ...walk("worker")].filter((f) => DRIVER.test(read(f)));
  assert(
    offenders.length === 0,
    `nothing under src/ or worker/ imports a Postgres driver (DEPLOY.md capacity note): ${offenders.join(", ") || "none"}`,
  );
  assert(DRIVER.test('import { Client } from "pg";'), "control: a pg import is recognised");
  assert(DRIVER.test("const sql = require('postgres');"), "control: a postgres require is recognised");
  const capacity = section(read("DEPLOY.md"), "Capacity: the database and the Google quota (#3124)");
  assert(capacity.includes("scripts/test-ops-doc-claims.ts"), "the capacity note names the check that keeps it true");
}

// --- #3129: DEPLOY.md names the public booking switch as it really is ----------
{
  const text = section(read("DEPLOY.md"), "Feature flags and the kill switch (#1052)");
  assert(text.length > 0, "DEPLOY.md has its kill switch section");
  assert(!/there is no kill switch/i.test(text), "DEPLOY.md no longer says there is no kill switch");

  const catalog = read("src/lib/notify/alert-catalog.ts");
  assert(/key:\s*"public_booking_stopped"/.test(catalog), "public_booking_stopped is a catalogued alert key");
  assert(text.includes("`public_booking_stopped`"), "DEPLOY.md names the public_booking_stopped alert");

  assert(text.includes("`/admin/business-hours`"), "DEPLOY.md says where the switch is");
  const page = read("src/app/admin/business-hours/page.tsx");
  assert(/<PublicBookingSwitch\b/.test(page), "the switch is rendered on /admin/business-hours");
  const control = read("src/components/admin/PublicBookingSwitch.tsx");
  for (const label of ["Stop online booking", "Start online booking"]) {
    assert(control.includes(label), `the switch's button reads "${label}"`);
    assert(text.includes(`**${label}**`), `DEPLOY.md names the "${label}" button`);
  }

  const copy = /bookingsPaused:\s*\n?\s*"([^"]+)"/.exec(read("src/lib/booking/booker-copy.ts"))?.[1];
  assert(!!copy, "the paused booker copy is readable");
  assert(!!copy && text.replace(/\s+/g, " ").includes(copy), "DEPLOY.md quotes the sentence a paused lead reads");
  assert(existsSync(".github/workflows/kill-switch.yml"), "the nightly kill switch proof DEPLOY.md names exists");
}

// --- #3097: local dev is warned off production ---------------------------------
{
  const setup = section(read("README.md"), "Setup");
  assert(/\[!WARNING\]/.test(setup), "README Setup carries a boxed warning");
  for (const key of ["SUPABASE_SECRET_KEY", "SLACK_BOT_TOKEN"]) {
    assert(setup.includes(`\`${key}\``), `README's warning names ${key}`);
  }
  const env = read(".env.example");
  const warnBefore = (key: string) => {
    const at = env.indexOf(`\n${key}=`);
    const block = env.slice(Math.max(0, env.lastIndexOf("# ---", at)), at);
    return /WARNING \(#3097\)/.test(block);
  };
  assert(warnBefore("SUPABASE_SECRET_KEY"), ".env.example warns in the Supabase block");
  assert(warnBefore("SLACK_BOT_TOKEN"), ".env.example warns in the Slack block");
}

// --- #3130: every ADR is indexed, and a PR is asked whether it needs one --------
{
  const index = read("docs/adr/README.md");
  const files = readdirSync("docs/adr").filter((f) => /^\d{4}-.+\.md$/.test(f));
  assert(files.length >= 10, `docs/adr holds the backfilled records (found ${files.length})`);
  for (const f of files) assert(index.includes(`(./${f})`), `docs/adr/README.md links ${f}`);
  for (const m of index.matchAll(/\(\.\/(\d{4}-[^)]+\.md)\)/g)) {
    assert(files.includes(m[1]), `docs/adr/README.md links a record that exists: ${m[1]}`);
  }
  assert(/## When to write one/.test(index), "docs/adr/README.md says when a record is due");
  assert(/^## Decision record$/m.test(read(".github/pull_request_template.md")), "the PR template asks about a decision record");
  assert(read("docs/review-process.md").includes("docs/adr/"), "review-process.md points at docs/adr");
}

// --- #3131: the system context diagram, and the credential table it links -------
{
  const arch = read("docs/architecture.md");
  const ctx = section(arch, "System context: everything Slate talks to");
  assert(/```mermaid/.test(ctx), "architecture.md has a system context diagram");
  for (const system of [
    "Supabase", "Google Calendar", "Salesforce", "Twilio", "Regal", "Cadence",
    "Slack", "Snowflake", "cal.com", "trypennie", "Supabase Auth",
  ]) {
    assert(ctx.includes(system), `the system context diagram shows ${system}`);
  }
  assert(ctx.includes("./api.md#credentials-and-auth-models"), "the diagram links the credentials table");
  assert(/^## Credentials and auth models$/m.test(read("docs/api.md")), "docs/api.md has the heading that anchor names");

  // Every secret the diagram names is a real configuration name.
  const known = read(".env.example") + read("DEPLOY.md");
  for (const m of ctx.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)) {
    assert(known.includes(m[1]), `the diagram's ${m[1]} is a documented setting`);
  }
}

finish();
